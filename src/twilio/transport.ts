/**
 * TwilioMediaTransport — framing layer over one Twilio Media Stream WebSocket.
 *
 * Wraps any ws-shaped socket (`ws`, @fastify/websocket, express-ws all hand
 * you one), parses inbound frames into typed events, and provides outbound
 * send helpers that carry the streamSid captured from `start`.
 *
 * The handshake (`awaitStart`) tolerates Twilio's `connected` preamble without
 * hardcoding it, bounds the number of pre-start frames, and times out — a
 * socket that never sends `start` must not leak a session.
 */

import { TypedEmitter } from '../internal/events.js';
import {
  parseTwilioMessage,
  type TwilioDtmfEvent,
  type TwilioMarkEvent,
  type TwilioMediaEvent,
  type TwilioStartEvent,
  type TwilioStopEvent,
} from './messages.js';

/** Minimal ws-shaped socket. `ws`-package sockets satisfy this directly. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown, isBinary?: boolean) => void): unknown;
  on(event: 'close', listener: (code?: number, reason?: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  readyState?: number;
}

/** ws.OPEN — sockets without readyState are assumed open. */
const OPEN = 1;

export interface TransportEvents extends Record<string, (...args: any[]) => void> {
  start: (event: TwilioStartEvent) => void;
  media: (event: TwilioMediaEvent) => void;
  stop: (event: TwilioStopEvent) => void;
  mark: (event: TwilioMarkEvent) => void;
  dtmf: (event: TwilioDtmfEvent) => void;
  close: (info: { code?: number; reason?: string }) => void;
  error: (error: Error) => void;
}

export interface AwaitStartOptions {
  /** Max time to wait for the `start` frame. Default 5000. */
  timeoutMs?: number;
  /** Max non-start frames tolerated before giving up. Default 8. */
  maxPreStartMessages?: number;
}

export class TwilioMediaTransport extends TypedEmitter<TransportEvents> {
  private readonly ws: WebSocketLike;
  private streamSidValue: string | null = null;
  private startEvent: TwilioStartEvent | null = null;
  private closed = false;

  constructor(ws: WebSocketLike) {
    super();
    this.ws = ws;
    ws.on('message', (data) => this.handleMessage(data));
    ws.on('close', (code, reason) => {
      this.closed = true;
      this.emit('close', { code, reason: reason?.toString() });
    });
    ws.on('error', (error) => this.emit('error', error));
  }

  get streamSid(): string | null {
    return this.streamSidValue;
  }

  get start(): TwilioStartEvent | null {
    return this.startEvent;
  }

  get isOpen(): boolean {
    return !this.closed && (this.ws.readyState === undefined || this.ws.readyState === OPEN);
  }

  /**
   * Resolve with the `start` frame, or reject on timeout / too many pre-start
   * frames / socket close. Media frames arriving before `start` are counted
   * but not delivered (there is no session to deliver them to yet).
   */
  awaitStart(options: AwaitStartOptions = {}): Promise<TwilioStartEvent> {
    if (this.startEvent) return Promise.resolve(this.startEvent);
    const timeoutMs = options.timeoutMs ?? 5000;
    const maxPreStart = options.maxPreStartMessages ?? 8;

    return new Promise<TwilioStartEvent>((resolve, reject) => {
      let preStartSeen = 0;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Twilio start frame not received within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      const onStart = (event: TwilioStartEvent) => {
        cleanup();
        resolve(event);
      };
      const onPreStart = () => {
        preStartSeen++;
        if (preStartSeen > maxPreStart) {
          cleanup();
          reject(new Error(`no start frame within the first ${maxPreStart} messages`));
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error('socket closed before start frame'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('start', onStart);
        this.off('close', onClose);
        this.off('media', onPreStart);
      };

      this.on('start', onStart);
      this.on('media', onPreStart);
      this.on('close', onClose);
    });
  }

  /** Forward one media payload (base64 μ-law) to the caller. */
  sendMedia(payload: string): void {
    const streamSid = this.requireStreamSid();
    this.sendRaw(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
  }

  /** Interleave a named mark; Twilio echoes it once playout reaches it. */
  sendMark(name: string): void {
    const streamSid = this.requireStreamSid();
    this.sendRaw(JSON.stringify({ event: 'mark', streamSid, mark: { name } }));
  }

  /** Flush Twilio's playout buffer (barge-in). Pending marks echo back as discarded. */
  sendClear(): void {
    const streamSid = this.requireStreamSid();
    this.sendRaw(JSON.stringify({ event: 'clear', streamSid }));
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      // Socket may already be dead; teardown must not throw.
    }
  }

  private handleMessage(data: unknown): void {
    const message = parseTwilioMessage(data as string | Buffer);
    if (!message) return;
    switch (message.event) {
      case 'start':
        this.startEvent = message;
        this.streamSidValue = message.start.streamSid ?? message.streamSid;
        this.emit('start', message);
        break;
      case 'media':
        this.emit('media', message);
        break;
      case 'stop':
        this.emit('stop', message);
        break;
      case 'mark':
        this.emit('mark', message);
        break;
      case 'dtmf':
        this.emit('dtmf', message);
        break;
      case 'connected':
        break;
    }
  }

  private requireStreamSid(): string {
    if (!this.streamSidValue) {
      throw new Error('cannot send to Twilio before the start frame (no streamSid yet)');
    }
    return this.streamSidValue;
  }

  private sendRaw(json: string): void {
    if (!this.isOpen) return;
    try {
      this.ws.send(json);
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }
}
