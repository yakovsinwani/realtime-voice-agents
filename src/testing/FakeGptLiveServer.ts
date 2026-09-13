/**
 * FakeGptLiveServer — a scripted GPT-Live (`/v1/live/sessions`) server on a
 * local port.
 *
 * Speaks just enough of the wire protocol to exercise the provider and the
 * full bridge without network or API keys: `session.started` on
 * `session.start`, acks for appends / updates, `session.closed` on
 * `session.close`, plus push helpers for the full-duplex output stream
 * (speech chunks followed by scripted silence — the provider's speech gate
 * closes on quiet AUDIO, so tests never wait on wall-clock), timed transcript
 * fragments, backend function calls wrapped in `response.event` envelopes,
 * and usage ticks. Every client frame is recorded for assertions.
 */

import type { IncomingHttpHeaders } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { MULAW_SILENCE_BYTE, pcm16ToMulaw } from '../audio/mulaw.js';

export interface FakeGptLiveServerOptions {
  /** Auto-ack appends / session.update with their `…ed` event. Default true. */
  autoAck?: boolean;
  /** Reject every `session.start` with this error (strict-schema style). */
  rejectStart?: { code: string; message: string; param?: string };
  /** Close each new socket before `session.started` (provider down). Mutable at runtime. */
  refuseConnections?: boolean;
  /** Reject the HTTP upgrade itself (401 bad key, 403 no access…). Mutable at runtime. */
  rejectUpgrade?: { status: number; body?: string };
  /** Seconds until `expires_at` in `session.started`. Default 7200 (the real limit). */
  sessionTtlSeconds?: number;
}

export interface FakeSpeechOptions {
  /** Base64 μ-law deltas of the utterance (use `mulawToneBase64`). */
  chunks: string[];
  /** Digital silence streamed after the chunks, closing the gate. Default 1000 (> the 800 ms quiet window). */
  silenceMs?: number;
  /** Output transcript sent as one fragment per word, on the session timeline. */
  transcript?: string;
  /** Session-timeline position of the utterance. Default: after the previous one. */
  startMs?: number;
}

let sessionCounter = 0;
let callCounter = 0;

/** `ms` of base64 μ-law digital silence, in 100 ms deltas like the real stream. */
export function mulawSilenceDeltas(ms: number): string[] {
  const deltas: string[] = [];
  for (let sent = 0; sent < ms; sent += 100) {
    const len = Math.min(100, ms - sent) * 8;
    deltas.push(Buffer.alloc(len, MULAW_SILENCE_BYTE).toString('base64'));
  }
  return deltas;
}

/** `ms` of a 440 Hz tone at ≈ −20 dBFS as one base64 μ-law delta (reads as speech to the gate). */
export function mulawToneBase64(ms: number, amplitude = 3200): string {
  const samples = ms * 8;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 8000));
  return Buffer.from(pcm16ToMulaw(pcm)).toString('base64');
}

export class FakeGptLiveConnection {
  readonly socket: WebSocket;
  /** Every parsed client → server frame, in order. */
  readonly received: Array<Record<string, any>> = [];
  readonly upgradeHeaders: IncomingHttpHeaders;
  /** The resolved session sent back in `session.started`. */
  session: Record<string, any> | null = null;
  /** Running session-timeline position for scripted speech / transcripts. */
  timelineMs = 0;
  private readonly server: FakeGptLiveServer;

  constructor(server: FakeGptLiveServer, socket: WebSocket, upgradeHeaders: IncomingHttpHeaders = {}) {
    this.server = server;
    this.socket = socket;
    this.upgradeHeaders = upgradeHeaders;
  }

  /** The `session` object of the client's `session.start`, once received. */
  get startFrame(): Record<string, any> | undefined {
    return this.received.find((f) => f.type === 'session.start');
  }

  /** Base64 payloads from `session.input_audio.append` frames. */
  get appendedAudio(): string[] {
    return this.received.filter((f) => f.type === 'session.input_audio.append').map((f) => f.audio as string);
  }

  /** Text appends (instructions / thinking / commentary), in order. */
  get appends(): Array<{ type: string; content: string; delegation_id: string | null }> {
    return this.received
      .filter((f) => /^session\.(instructions|thinking|commentary)\.append$/.test(f.type))
      .map((f) => ({ type: f.type, content: f.content, delegation_id: f.delegation_id ?? null }));
  }

  eventsOfType(type: string): Array<Record<string, any>> {
    return this.received.filter((f) => f.type === type);
  }

  async waitForEvent(
    predicate: string | ((frame: Record<string, any>) => boolean),
    timeoutMs = 2000,
  ): Promise<Record<string, any>> {
    const matches = typeof predicate === 'string' ? (frame: Record<string, any>) => frame.type === predicate : predicate;
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    while (Date.now() < deadline) {
      for (; seen < this.received.length; seen++) {
        const frame = this.received[seen]!;
        if (matches(frame)) return frame;
      }
      await delay(5);
    }
    throw new Error(`timed out waiting for client event; got: ${this.received.map((f) => f.type).join(', ')}`);
  }

  send(frame: Record<string, unknown>): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  /** Stream one utterance: speech chunks, then silence that closes the gate, then its transcript. */
  sendSpeech(options: FakeSpeechOptions): { startMs: number; endMs: number } {
    const startMs = options.startMs ?? this.timelineMs;
    let cursor = startMs;
    for (const chunk of options.chunks) {
      this.send({ type: 'session.output_audio.delta', event_id: `evt_${Date.now()}`, delta: chunk });
      cursor += (Buffer.from(chunk, 'base64').length / 8) | 0;
    }
    const endMs = cursor;
    for (const chunk of mulawSilenceDeltas(options.silenceMs ?? 1000)) {
      this.send({ type: 'session.output_audio.delta', event_id: `evt_${Date.now()}`, delta: chunk });
    }
    this.timelineMs = cursor + (options.silenceMs ?? 1000);
    if (options.transcript) this.sendOutputTranscript(options.transcript, { startMs, endMs });
    return { startMs, endMs };
  }

  /** Continuous idle output: `ms` of digital silence (what the real stream sends while quiet). */
  sendSilence(ms: number): void {
    for (const chunk of mulawSilenceDeltas(ms)) {
      this.send({ type: 'session.output_audio.delta', event_id: `evt_${Date.now()}`, delta: chunk });
    }
    this.timelineMs += ms;
  }

  /** Caller transcript, one fragment per word across [startMs, endMs] on the session timeline. */
  sendInputTranscript(text: string, range: { startMs?: number; endMs?: number } = {}): void {
    this.sendFragments('session.input_transcript.delta', text, range);
  }

  sendOutputTranscript(text: string, range: { startMs?: number; endMs?: number } = {}): void {
    this.sendFragments('session.output_transcript.delta', text, range);
  }

  /** A backend function call: delegation created, then the call in a `response.event` envelope. */
  sendFunctionCall(options: { name: string; argumentsJson?: string; callId?: string; delegationId?: string }): string {
    const callId = options.callId ?? `call_${++callCounter}`;
    const delegationId = options.delegationId ?? `item_${callCounter}`;
    this.send({
      type: 'session.delegation.created',
      event_id: `evt_${Date.now()}`,
      offset_ms: this.timelineMs,
      delegation: { id: delegationId, type: 'delegation', target: 'responses', response_id: `resp_${callCounter}` },
    });
    this.send({
      type: 'response.event',
      event_id: `evt_${Date.now()}`,
      delegation_id: delegationId,
      event: {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: `fc_${callCounter}`, call_id: callId, name: options.name, arguments: options.argumentsJson ?? '{}', status: 'completed' },
      },
    });
    return callId;
  }

  /** The backend finished a response (carries token usage). */
  sendBackendCompleted(options: { delegationId?: string; usage?: Record<string, unknown>; text?: string } = {}): void {
    this.send({
      type: 'response.event',
      event_id: `evt_${Date.now()}`,
      delegation_id: options.delegationId ?? null,
      event: {
        type: 'response.completed',
        response: {
          id: `resp_${Date.now()}`,
          status: 'completed',
          usage: options.usage ?? { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          output: options.text ? [{ type: 'message', content: [{ type: 'output_text', text: options.text }] }] : [],
        },
      },
    });
  }

  /** Cumulative session seconds, like the real 15 s ticks. */
  sendUsage(seconds: number, contextRatio = 0.01): void {
    this.send({ type: 'session.usage.updated', event_id: `evt_${Date.now()}`, usage: { seconds }, context_window: { usage_ratio: contextRatio } });
  }

  sendError(error: Record<string, unknown>): void {
    this.send({ type: 'error', event_id: `evt_${Date.now()}`, error });
  }

  /** Server-side session end (`expired`, `content`…): session.closed then the socket. */
  closeSession(reason: 'expired' | 'content' | 'remote_hangup' | 'connection_lost' | 'close_requested', usageSeconds = 0): void {
    this.send({ type: 'session.closed', event_id: `evt_${Date.now()}`, reason, usage: { seconds: usageSeconds }, session: this.session });
    this.socket.close(1000, reason);
  }

  drop(code = 1011, reason = 'fake server drop'): void {
    this.socket.close(code, reason);
  }

  private sendFragments(type: string, text: string, range: { startMs?: number; endMs?: number }): void {
    const words = text.split(/(\s+)/).filter((w) => w.length > 0);
    const startMs = range.startMs ?? this.timelineMs;
    const endMs = range.endMs ?? startMs + Math.max(200, words.length * 200);
    const step = words.length > 0 ? (endMs - startMs) / words.length : 0;
    words.forEach((word, index) => {
      const s = Math.round(startMs + index * step);
      const e = Math.round(index === words.length - 1 ? endMs : startMs + (index + 1) * step);
      this.send({ type, event_id: `evt_${Date.now()}_${index}`, delta: word, start_ms: s, end_ms: e });
    });
    if (range.startMs === undefined) this.timelineMs = Math.max(this.timelineMs, endMs);
  }

  /** @internal server plumbing */
  handleClientFrame(frame: Record<string, any>): void {
    this.received.push(frame);
    const options = this.server.options;
    if (frame.type === 'session.start') {
      if (options.rejectStart) {
        this.send({ type: 'error', event_id: `evt_${Date.now()}`, error: { type: 'invalid_request_error', ...options.rejectStart, client_event_id: frame.event_id } });
        return;
      }
      this.session = {
        id: `live_fake_${++sessionCounter}`,
        expires_at: Math.floor(Date.now() / 1000) + (options.sessionTtlSeconds ?? 7200),
        ...frame.session,
      };
      this.send({ type: 'session.started', event_id: `evt_${Date.now()}`, client_event_id: frame.event_id, session: this.session });
      return;
    }
    if (frame.type === 'session.close') {
      this.send({ type: 'session.closed', event_id: `evt_${Date.now()}`, client_event_id: frame.event_id, reason: 'close_requested', usage: { seconds: Math.round(this.timelineMs / 1000) }, session: this.session });
      this.socket.close(1000, 'close_requested');
      return;
    }
    if (options.autoAck === false) return;
    const acks: Record<string, string> = {
      'session.instructions.append': 'session.instructions.appended',
      'session.thinking.append': 'session.thinking.appended',
      'session.commentary.append': 'session.commentary.appended',
      'session.update': 'session.updated',
      'session.input_audio.mute': 'session.input_audio.muted',
      'session.input_audio.unmute': 'session.input_audio.unmuted',
    };
    const ackType = acks[frame.type];
    if (!ackType) return;
    const ack: Record<string, unknown> = { type: ackType, event_id: `evt_${Date.now()}`, client_event_id: frame.event_id };
    if (ackType.endsWith('appended')) {
      ack.start_ms = this.timelineMs;
      ack.end_ms = this.timelineMs + 200;
    }
    if (ackType === 'session.updated') ack.session = { ...this.session, ...frame.session };
    this.send(ack);
  }
}

export class FakeGptLiveServer {
  readonly connections: FakeGptLiveConnection[] = [];
  refuseConnections: boolean;
  refusedConnections = 0;
  rejectUpgrade: { status: number; body?: string } | null;
  rejectedUpgrades = 0;
  readonly url: string;
  /** @internal */
  readonly options: FakeGptLiveServerOptions;
  private readonly wss: WebSocketServer;

  private constructor(wss: WebSocketServer, url: string, options: FakeGptLiveServerOptions) {
    this.wss = wss;
    this.url = url;
    this.options = options;
    this.refuseConnections = options.refuseConnections ?? false;
    this.rejectUpgrade = options.rejectUpgrade ?? null;
    wss.on('connection', (socket, request) => {
      if (this.refuseConnections) {
        this.refusedConnections++;
        socket.close(1011, 'fake server refusing sessions');
        return;
      }
      const connection = new FakeGptLiveConnection(this, socket, request.headers);
      this.connections.push(connection);
      socket.on('message', (raw) => {
        let frame: Record<string, any>;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return;
        }
        connection.handleClientFrame(frame);
      });
    });
  }

  static async start(options: FakeGptLiveServerOptions = {}): Promise<FakeGptLiveServer> {
    const holder: { server?: FakeGptLiveServer } = {};
    const wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: (_info: unknown, done: (ok: boolean, code?: number, message?: string) => void) => {
        const reject = holder.server?.rejectUpgrade;
        if (reject) {
          holder.server!.rejectedUpgrades++;
          done(false, reject.status, reject.body ?? 'rejected by fake server');
          return;
        }
        done(true);
      },
    });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    const address = wss.address();
    if (typeof address === 'string' || address === null) throw new Error('no server address');
    const server = new FakeGptLiveServer(wss, `ws://127.0.0.1:${address.port}`, options);
    holder.server = server;
    return server;
  }

  get latest(): FakeGptLiveConnection {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) throw new Error('no connections yet');
    return connection;
  }

  async waitForConnection(timeoutMs = 2000): Promise<FakeGptLiveConnection> {
    const count = this.connections.length;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connections.length > count) return this.connections[this.connections.length - 1]!;
      await delay(5);
    }
    throw new Error('timed out waiting for a provider connection');
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      try {
        connection.socket.terminate();
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
