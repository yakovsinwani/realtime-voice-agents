/**
 * FakeTwilioMediaStream — a deterministic stand-in for Twilio's side of a
 * Media Stream WebSocket.
 *
 * It exposes the ws-shaped surface the bridge consumes (send/close/on), and a
 * test-driver surface for the "caller": connect(), sendMedia(), stop(), plus a
 * manual playout clock (`advancePlayback`) that emulates Twilio's buffer-and-
 * play-in-order behavior:
 *
 * - outbound `media` frames queue with duration = μ-law bytes / 8 per ms
 * - outbound `mark` frames queue in order and echo back once playout reaches
 *   them
 * - outbound `clear` drops everything buffered and immediately echoes every
 *   pending mark (exactly what real Twilio does with interrupted marks)
 *
 * No wall-clock timers: tests advance playback explicitly, so scenarios are
 * fully deterministic.
 */

import { MULAW_SILENCE_BYTE, base64ByteLength } from '../audio/mulaw.js';
import type { WebSocketLike } from '../twilio/transport.js';

type QueueItem =
  | { kind: 'media'; remainingMs: number; totalMs: number }
  | { kind: 'mark'; name: string };

type MessageListener = (data: string, isBinary?: boolean) => void;
type CloseListener = (code?: number, reason?: string) => void;
type ErrorListener = (error: Error) => void;

export interface FakeConnectOptions {
  callSid?: string;
  streamSid?: string;
  accountSid?: string;
  customParameters?: Record<string, string>;
  /** Send Twilio's `connected` preamble frame before `start`. Default true. */
  sendConnectedFrame?: boolean;
}

/** Base64 μ-law silence of the given duration (whole milliseconds at 8 kHz). */
export function mulawSilenceBase64(ms: number): string {
  return Buffer.alloc(Math.round(ms * 8), MULAW_SILENCE_BYTE).toString('base64');
}

export class FakeTwilioMediaStream implements WebSocketLike {
  readyState = 1;

  readonly callSid: string;
  readonly streamSid: string;

  /** Everything the bridge sent, parsed, in order. */
  readonly outbound: Array<Record<string, any>> = [];
  /** Base64 payloads of outbound media frames, in order. */
  readonly sentMediaPayloads: string[] = [];
  /** Names of marks echoed back to the bridge (played or discarded). */
  readonly echoedMarks: string[] = [];
  /** Number of `clear` frames received from the bridge. */
  clearCount = 0;

  private readonly messageListeners: MessageListener[] = [];
  private readonly closeListeners: CloseListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];
  private readonly playoutQueue: QueueItem[] = [];
  private playedMsTotal = 0;
  private callerClockMs = 0;
  private mediaSequence = 0;
  private closedByBridge = false;

  constructor(options: { callSid?: string; streamSid?: string } = {}) {
    this.callSid = options.callSid ?? 'CA' + 'f'.repeat(32);
    this.streamSid = options.streamSid ?? 'MZ' + 'f'.repeat(32);
  }

  // ---- ws-shaped surface (consumed by the bridge) --------------------------

  send(data: string): void {
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    this.outbound.push(frame);
    switch (frame.event) {
      case 'media': {
        const payload: string = frame.media?.payload ?? '';
        this.sentMediaPayloads.push(payload);
        const ms = base64ByteLength(payload) / 8;
        this.playoutQueue.push({ kind: 'media', remainingMs: ms, totalMs: ms });
        break;
      }
      case 'mark':
        this.playoutQueue.push({ kind: 'mark', name: frame.mark?.name ?? '' });
        break;
      case 'clear': {
        this.clearCount++;
        // Twilio discards buffered audio and echoes every outstanding mark.
        const pendingMarks = this.playoutQueue.filter((i) => i.kind === 'mark');
        this.playoutQueue.length = 0;
        for (const mark of pendingMarks) this.echoMark((mark as { name: string }).name);
        break;
      }
    }
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedByBridge = true;
    for (const listener of this.closeListeners) listener(code ?? 1000, reason);
  }

  on(event: 'message', listener: MessageListener): this;
  on(event: 'close', listener: CloseListener): this;
  on(event: 'error', listener: ErrorListener): this;
  on(event: string, listener: any): this {
    if (event === 'message') this.messageListeners.push(listener);
    else if (event === 'close') this.closeListeners.push(listener);
    else if (event === 'error') this.errorListeners.push(listener);
    return this;
  }

  // ---- caller-side driver (used by tests) ---------------------------------

  /** Send the `connected` preamble and `start` frame. */
  connect(options: FakeConnectOptions = {}): void {
    if (options.sendConnectedFrame !== false) {
      this.deliver({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    }
    this.deliver({
      event: 'start',
      sequenceNumber: '1',
      streamSid: options.streamSid ?? this.streamSid,
      start: {
        streamSid: options.streamSid ?? this.streamSid,
        accountSid: options.accountSid ?? 'AC' + 'f'.repeat(32),
        callSid: options.callSid ?? this.callSid,
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        customParameters: options.customParameters ?? {},
      },
    });
  }

  /** Deliver one caller media frame (base64 μ-law) to the bridge. */
  sendMedia(payload: string): void {
    this.mediaSequence++;
    const ms = base64ByteLength(payload) / 8;
    this.deliver({
      event: 'media',
      sequenceNumber: String(this.mediaSequence + 1),
      streamSid: this.streamSid,
      media: {
        track: 'inbound',
        chunk: String(this.mediaSequence),
        timestamp: String(Math.round(this.callerClockMs)),
        payload,
      },
    });
    this.callerClockMs += ms;
  }

  /** Deliver `ms` of caller silence as 20 ms μ-law frames. */
  sendSilence(ms: number): void {
    let remaining = ms;
    while (remaining > 0) {
      const frameMs = Math.min(20, remaining);
      this.sendMedia(mulawSilenceBase64(frameMs));
      remaining -= frameMs;
    }
  }

  sendDtmf(digit: string): void {
    this.deliver({
      event: 'dtmf',
      streamSid: this.streamSid,
      dtmf: { track: 'inbound_track', digit },
    });
  }

  /** Deliver the `stop` frame (Twilio ended the stream). */
  stop(): void {
    this.deliver({
      event: 'stop',
      streamSid: this.streamSid,
      stop: { callSid: this.callSid },
    });
  }

  /** Simulate the socket dropping from Twilio's side. */
  disconnect(code = 1006, reason = 'connection lost'): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of this.closeListeners) listener(code, reason);
  }

  // ---- playout simulation -------------------------------------------------

  /** Total milliseconds of agent audio actually "played" to the caller. */
  get playedMs(): number {
    return this.playedMsTotal;
  }

  /** Milliseconds of agent audio still buffered. */
  get queuedMs(): number {
    return this.playoutQueue.reduce(
      (sum, item) => sum + (item.kind === 'media' ? item.remainingMs : 0),
      0,
    );
  }

  get wasClosedByBridge(): boolean {
    return this.closedByBridge;
  }

  /**
   * Advance the playout clock: consume buffered media in order and echo each
   * mark as playout reaches it.
   */
  advancePlayback(ms: number): void {
    let budget = ms;
    while (this.playoutQueue.length > 0) {
      const head = this.playoutQueue[0]!;
      if (head.kind === 'mark') {
        this.playoutQueue.shift();
        this.echoMark(head.name);
        continue;
      }
      if (budget <= 0) break;
      const consumed = Math.min(budget, head.remainingMs);
      head.remainingMs -= consumed;
      budget -= consumed;
      this.playedMsTotal += consumed;
      if (head.remainingMs <= 1e-9) this.playoutQueue.shift();
    }
    // Marks now at the head (their media fully played) echo even if budget hit 0.
    while (this.playoutQueue[0]?.kind === 'mark') {
      const mark = this.playoutQueue.shift() as { kind: 'mark'; name: string };
      this.echoMark(mark.name);
    }
  }

  /** Play out everything currently buffered. */
  playAll(): void {
    this.advancePlayback(Number.MAX_SAFE_INTEGER);
  }

  // ---- internals ----------------------------------------------------------

  private echoMark(name: string): void {
    this.echoedMarks.push(name);
    this.deliver({ event: 'mark', streamSid: this.streamSid, mark: { name } });
  }

  private deliver(frame: Record<string, unknown>): void {
    if (this.readyState === 3) return;
    const data = JSON.stringify(frame);
    for (const listener of this.messageListeners) listener(data);
  }
}
