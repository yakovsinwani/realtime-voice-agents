/**
 * GPT-Live provider (`/v1/live/sessions`, raw WebSocket) — OpenAI's
 * full-duplex speech-to-speech model. A different API from Realtime, not a
 * new Realtime model: its own handshake (`session.start` → `session.started`),
 * its own events, and a different division of labour that this provider
 * translates into the engine's normalized contract:
 *
 * - **Turn-taking is the model's.** It listens while it speaks and stops on
 *   its own when the caller talks. There is no VAD config, no cancel, no
 *   truncate, no speech_started/stopped; `capabilities.turnTaking: 'model'`
 *   tells the engine to keep its hands off (see parity tests).
 * - **Output is a continuous real-time stream, silence included** (100 ms
 *   μ-law deltas, digital 0xFF when quiet). Response boundaries are
 *   synthesized by a speech gate on the audio itself (`speech-gate.ts`);
 *   silence between utterances is not forwarded.
 * - **The backend does the thinking.** Tools are declared on a Responses
 *   model (`delegation.responses`), calls arrive wrapped in `response.event`
 *   envelopes, results go back as `response.item.create` + one
 *   `response.create`. The voice keeps talking meanwhile
 *   (`capabilities.decoupledBackend`).
 * - **Text reaches the model only through appends** (≤ 500 tokens each):
 *   instructions (policy), thinking (quiet context), commentary (say this).
 *   `createResponse({ instructions })` maps to commentary — field-tested as
 *   the only append that reliably produces speech on demand (Sept 2026).
 * - **Instructions, voice and history are immutable after start** — handoffs
 *   reconnect and seed the attributed transcript via `session.input`
 *   (`capabilities.startupHistory`).
 * - **Billing is per second of session**, reported as cumulative
 *   `session.usage.updated` ticks; `close()` sends `session.close` and waits
 *   for `session.closed` so the final usage is confirmed.
 */

import WebSocket from 'ws';
import { deepMerge } from '../../internal/merge.js';
import type { Logger } from '../../logging/logger.js';
import { noopLogger } from '../../logging/logger.js';
import {
  BaseRealtimeProvider,
  type ProviderSessionInit,
  type SendTextOptions,
  type SendToolResultOptions,
  type SessionUpdateOptions,
} from '../base/BaseRealtimeProvider.js';
import type { ProviderCapabilities } from '../base/capabilities.js';
import type { ProviderUsage } from '../base/events.js';
import { normalizeUsage } from '../openai-compatible/OpenAICompatibleProvider.js';
import {
  buildSessionStart,
  toBackendTool,
  type GptLiveDelegationOptions,
  type GptLiveSessionConfig,
} from './session-config.js';
import { DEFAULT_GATE_QUIET_MS, SpeechGate, type SpeechGateOptions } from './speech-gate.js';
import { TranscriptGrouper } from './transcript-grouper.js';

export const GPT_LIVE_DEFAULT_BASE_URL = 'wss://api.openai.com/v1/live/sessions';

export interface GptLiveProviderConfig {
  apiKey: string;
  /** Live model id. */
  model: string;
  /** Default output voice when the Agent doesn't set one. */
  voice?: string;
  /** Override the WS endpoint (proxies, Azure `…/openai/v1/live`). */
  baseUrl?: string;
  /** Extra WS headers. */
  headers?: Record<string, string>;
  /** Backend (Responses) delegation — the half of the prompt that reasons and calls tools. */
  delegation?: GptLiveDelegationOptions;
  /** Store the session server-side (30 days) for recording download / forking. Default false. */
  store?: boolean;
  /** Provider-native session fields, deep-merged into `session.start` last (strict schema!). */
  extraSessionOptions?: Record<string, unknown>;
  connectTimeoutMs?: number;
  /** How long `close()` waits for `session.closed` (final usage) before dropping the socket. Default 3000. */
  closeTimeoutMs?: number;
  /** Speech gate tuning (utterance boundaries synthesized from the audio). */
  speechGate?: SpeechGateOptions;
  /** Session-timeline gap that splits transcript fragments into turns. Default 800. */
  transcriptGapMs?: number;
  /** History trimming bounds for `session.input`. */
  historyMaxMessages?: number;
  historyMaxChars?: number;
  /** Ack wait for appends / updates. Default 5000. */
  ackTimeoutMs?: number;
  providerName?: string;
}

const NON_RETRIABLE_CLOSE_CODES = new Set([1002, 1003, 1007, 1008]);
/** Appends are capped at 500 tokens; split conservatively (dense scripts run ~2.5 chars/token). */
const APPEND_MAX_CHARS = 1200;
const TRANSCRIPT_IDLE_EXTRA_MS = 300;
const GATE_STALL_EXTRA_MS = 500;

type AppendType = 'session.instructions.append' | 'session.thinking.append' | 'session.commentary.append';

const ACK_TYPES: Record<string, string> = {
  'session.instructions.append': 'session.instructions.appended',
  'session.thinking.append': 'session.thinking.appended',
  'session.commentary.append': 'session.commentary.appended',
  'session.update': 'session.updated',
  'session.input_audio.mute': 'session.input_audio.muted',
  'session.input_audio.unmute': 'session.input_audio.unmuted',
};

interface AckWaiter {
  ackType: string;
  resolve: (acked: boolean) => void;
  timer: NodeJS.Timeout;
}

let eventSeq = 0;
const nextEventId = (prefix: string): string => `${prefix}_${++eventSeq}`;

export class GptLiveProvider extends BaseRealtimeProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities = {
    truncate: false,
    sessionUpdate: false,
    voiceChangeMidSession: false,
    transcodeRequired: false,
    resumption: false,
    agentTranscriptDeltas: true,
    vadInterruptControl: false,
    turnTaking: 'model',
    startupHistory: true,
    decoupledBackend: true,
  };

  private readonly config: GptLiveProviderConfig;
  private readonly logger: Logger;
  private ws: WebSocket | null = null;
  private ready = false;
  private intentionalClose = false;
  private sessionInit: ProviderSessionInit | null = null;
  /** Server-assigned session id (sideband attach, forking, recording download). */
  sessionId: string | null = null;
  /** Unix seconds at which the server expires the session (120 min at launch). */
  expiresAt: number | null = null;

  private readonly gate: SpeechGate;
  private gateStallTimer: NodeJS.Timeout | null = null;
  private utteranceCounter = 0;
  private currentUtteranceId: string | null = null;
  private lastUtteranceId: string | null = null;
  private readonly inputTranscript: TranscriptGrouper;
  private readonly outputTranscript: TranscriptGrouper;
  private readonly acks = new Map<string, AckWaiter>();
  private readonly seenCalls = new Set<string>();
  private sessionClosed: { reason?: string; usageSeconds?: number } | null = null;
  private closeListeners: Array<() => void> = [];

  constructor(config: GptLiveProviderConfig, logger: Logger = noopLogger) {
    super();
    this.config = config;
    this.logger = logger;
    this.name = config.providerName ?? 'gpt-live';
    this.gate = new SpeechGate(config.speechGate);
    const gapMs = config.transcriptGapMs ?? DEFAULT_GATE_QUIET_MS;
    this.inputTranscript = new TranscriptGrouper({
      gapMs,
      idleMs: gapMs + TRANSCRIPT_IDLE_EXTRA_MS,
      onTurn: (turn) => this.emit('userTranscript', { text: turn.text }),
    });
    this.outputTranscript = new TranscriptGrouper({
      gapMs,
      idleMs: gapMs + TRANSCRIPT_IDLE_EXTRA_MS,
      tagFor: () => this.currentUtteranceId ?? this.lastUtteranceId ?? undefined,
      onTurn: (turn) => this.emit('agentTranscript', { responseId: turn.tag ?? '', text: turn.text }),
    });
  }

  get isConnected(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(init: ProviderSessionInit): Promise<void> {
    if (this.ws) await this.close();
    this.sessionInit = init;
    this.intentionalClose = false;
    this.ready = false;
    this.sessionClosed = null;
    this.sessionId = null;
    this.expiresAt = null;
    this.resetUtteranceState();
    if (init.vad !== undefined || init.transcription !== undefined || init.temperature !== undefined) {
      this.logger.debug('gpt-live: vad/transcription/temperature are model-owned and ignored');
    }

    const startId = nextEventId('start');
    const { frame, droppedHistory } = buildSessionStart(init, this.sessionConfig(), startId, this.config.model);
    if (droppedHistory > 0) {
      this.logger.warn('gpt-live: startup history trimmed to the API bounds', { dropped: droppedHistory });
    }

    const ws = new WebSocket(this.config.baseUrl ?? GPT_LIVE_DEFAULT_BASE_URL, {
      headers: { Authorization: `Bearer ${this.config.apiKey}`, ...this.config.headers },
      // Real-time μ-law: per-message zlib only adds latency jitter.
      perMessageDeflate: false,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timeoutMs = this.config.connectTimeoutMs ?? 15_000;
      const timer = setTimeout(() => fail(new Error(`${this.name} session not started within ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        reject(error);
      };

      ws.on('unexpected-response', (_request, response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (body.length < 512) body += chunk;
        });
        response.on('end', () => {
          const detail = body.trim().slice(0, 500);
          this.logger.error('provider rejected the WebSocket upgrade', { status: response.statusCode, body: detail });
          fail(new Error(`${this.name} rejected the WebSocket upgrade: HTTP ${response.statusCode}${detail ? ` — ${detail}` : ''}`));
        });
      });
      ws.on('open', () => {
        this.emit('open');
        this.send(frame);
      });
      ws.on('message', (raw) => {
        const event = this.parseEvent(raw);
        if (!event) return;
        if (!settled) {
          if (event.type === 'session.started') {
            settled = true;
            clearTimeout(timer);
            this.sessionId = event.session?.id ?? null;
            this.expiresAt = typeof event.session?.expires_at === 'number' ? event.session.expires_at : null;
            this.ready = true;
            this.logger.info('gpt-live session started', {
              sessionId: this.sessionId,
              expiresAt: this.expiresAt ? new Date(this.expiresAt * 1000).toISOString() : undefined,
            });
            resolve();
            return;
          }
          if (event.type === 'error') {
            fail(new Error(`${this.name} session.start rejected: ${JSON.stringify(event.error ?? event)}`));
            return;
          }
          return; // nothing else is expected before session.started
        }
        this.handleEvent(event);
      });
      ws.on('error', (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        if (!settled) fail(err);
        else this.emit('error', err);
      });
      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf?.toString();
        this.ready = false;
        this.failPendingAcks();
        this.finishUtteranceOnClose();
        const listeners = this.closeListeners;
        this.closeListeners = [];
        for (const listener of listeners) listener();
        if (!settled) {
          fail(new Error(`${this.name} socket closed during setup (${code} ${reason ?? ''})`));
          return;
        }
        this.emit('close', { code, reason, retriable: this.isRetriableClose(code) });
      });
    });
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.ready = false;
    const ws = this.ws;
    this.ws = null;
    this.inputTranscript.dispose();
    this.outputTranscript.dispose();
    this.clearGateStall();
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    // Graceful: session.close → session.closed carries the confirmed final
    // usage. The socket is dropped regardless once the wait runs out — a
    // session left open keeps billing until it expires.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => finish(), this.config.closeTimeoutMs ?? 3000);
      timer.unref?.();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
        } catch {
          /* already closing */
        }
        setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            /* already gone */
          }
        }, 1000).unref?.();
        resolve();
      };
      this.closeListeners.push(finish);
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'session.close', event_id: nextEventId('close') }));
        } catch {
          finish();
        }
      } else {
        finish();
      }
    });
  }

  sendAudio(base64Mulaw: string): void {
    if (!this.isConnected) return;
    this.send({ type: 'session.input_audio.append', audio: base64Mulaw });
  }

  /**
   * Text has three doors into a GPT-Live session, by intent rather than by
   * conversation role: `system` → instructions (behaviour), `user` → thinking
   * (quiet context: keypad entries, deferred results — the model decides how
   * to react), `assistant` → thinking as well, worded as something already
   * said (commentary would make the model say it again).
   */
  sendText(text: string, options: SendTextOptions = {}): void {
    const role = options.role ?? 'user';
    if (role === 'system') {
      void this.append('session.instructions.append', text);
    } else if (role === 'assistant') {
      void this.append('session.thinking.append', `You already said this to the caller earlier: "${text}"`);
    } else {
      void this.append('session.thinking.append', text);
    }
  }

  sendToolResult(callId: string, output: unknown, options: SendToolResultOptions = {}): void {
    this.send({
      type: 'response.item.create',
      event_id: nextEventId('tool'),
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: typeof output === 'string' ? output : JSON.stringify(output ?? null),
      },
    });
    // The backend does not continue on its own after a result; one create
    // covers every result submitted before it (the engine sends the flag on
    // the last of a batch).
    if (options.triggerResponse !== false) {
      this.send({ type: 'response.create', event_id: nextEventId('continue') });
    }
  }

  /**
   * "Speak now" has no direct verb on this API. Commentary — information the
   * model should say aloud, paraphrasing allowed — is the append that
   * produced speech on demand in every field test, greeting and goodbye
   * alike; an instruction-shaped text is followed rather than read out.
   */
  createResponse(options: { instructions?: string } = {}): void {
    if (options.instructions) {
      void this.append('session.commentary.append', options.instructions);
    } else {
      void this.append('session.instructions.append', 'Respond to the caller now, without waiting for them to speak.');
    }
  }

  /**
   * Only the backend delegation can change mid-session (`session.update` is
   * sparse and limited to `delegation.responses`): tool lists land there;
   * instructions / voice / vad are immutable and are reported, not applied.
   */
  async updateSession(patch: Partial<ProviderSessionInit>, options: SessionUpdateOptions = {}): Promise<boolean> {
    if (!this.sessionInit) throw new Error('updateSession before connect');
    const ignored = Object.keys(patch).filter((key) => key !== 'tools' && key !== 'providerOptions');
    if (ignored.length > 0) {
      this.logger.warn('gpt-live: session fields are immutable after start — ignored', { fields: ignored });
    }
    this.sessionInit = { ...this.sessionInit, ...patch };
    let responses: Record<string, unknown> = {};
    if (patch.tools) {
      responses.tools = [...patch.tools.map(toBackendTool), ...(this.config.delegation?.extraTools ?? [])];
    }
    const nativeResponses = (patch.providerOptions as any)?.delegation?.responses;
    if (nativeResponses && typeof nativeResponses === 'object') responses = deepMerge(responses, nativeResponses);
    if (Object.keys(responses).length === 0) return false;
    if (!this.isConnected) return false;
    const eventId = nextEventId('update');
    const acked = this.awaitAck(eventId, ACK_TYPES['session.update']!);
    this.send({ type: 'session.update', event_id: eventId, session: { delegation: { type: 'responses', responses } } });
    return options.awaitAck ? acked : true;
  }

  // ---- inbound events ------------------------------------------------------

  private handleEvent(event: Record<string, any>): void {
    switch (event.type) {
      case 'session.output_audio.delta': {
        if (typeof event.delta !== 'string' || event.delta.length === 0) break;
        this.handleOutputAudio(event.delta);
        break;
      }
      case 'session.input_transcript.delta':
        if (typeof event.delta === 'string') {
          this.inputTranscript.push(event.delta, numberOr(event.start_ms, 0), numberOr(event.end_ms, 0));
        }
        break;
      case 'session.output_transcript.delta':
        if (typeof event.delta === 'string') {
          this.emit('agentTranscriptDelta', {
            responseId: this.currentUtteranceId ?? this.lastUtteranceId ?? '',
            delta: event.delta,
          });
          this.outputTranscript.push(event.delta, numberOr(event.start_ms, 0), numberOr(event.end_ms, 0));
        }
        break;
      case 'session.delegation.created':
        this.logger.debug('gpt-live delegation created', {
          id: event.delegation?.id,
          target: event.delegation?.target,
          responseId: event.delegation?.response_id,
        });
        break;
      case 'response.event':
        this.handleBackendEvent(event.event ?? {}, event.delegation_id);
        break;
      case 'session.usage.updated': {
        const seconds = event.usage?.seconds;
        if (typeof seconds === 'number') {
          this.emit('usage', { inputTokens: 0, outputTokens: 0, totalTokens: 0, audioSeconds: seconds, raw: event });
        }
        break;
      }
      case 'session.instructions.appended':
      case 'session.thinking.appended':
      case 'session.commentary.appended':
      case 'session.updated':
      case 'session.input_audio.muted':
      case 'session.input_audio.unmuted':
        this.resolveAck(event.client_event_id, true);
        break;
      case 'session.closed': {
        const seconds = event.usage?.seconds;
        this.sessionClosed = { reason: event.reason, usageSeconds: typeof seconds === 'number' ? seconds : undefined };
        this.logger.info('gpt-live session closed', { reason: event.reason, usageSeconds: seconds });
        if (typeof seconds === 'number') {
          this.emit('usage', { inputTokens: 0, outputTokens: 0, totalTokens: 0, audioSeconds: seconds, raw: event });
        }
        break;
      }
      case 'error': {
        if (event.error?.client_event_id) this.resolveAck(event.error.client_event_id, false);
        this.logger.warn('provider error event', { error: event.error });
        this.emit('error', new Error(`${this.name} error: ${JSON.stringify(event.error ?? event)}`));
        break;
      }
      case 'info':
        this.logger.debug('gpt-live info', { code: event.code, message: event.message });
        break;
      default:
        break;
    }
  }

  private handleOutputAudio(delta: string): void {
    const bytes = Buffer.from(delta, 'base64');
    const wasOpen = this.gate.isOpen;
    const events = this.gate.feed(bytes);
    let forwardId = wasOpen ? this.currentUtteranceId : null;
    let close: { utteranceMs: number } | null = null;
    for (const gateEvent of events) {
      if (gateEvent.type === 'open') {
        this.beginUtterance();
        forwardId = this.currentUtteranceId;
      } else {
        close = gateEvent;
      }
    }
    // Silence between utterances is the model's idle stream — not agent
    // speech, not marked, not forwarded (Twilio plays nothing = silence).
    if (forwardId) this.emit('audio', { base64Mulaw: delta, responseId: forwardId });
    if (close) this.endUtterance();
    else if (this.gate.isOpen) this.armGateStall();
  }

  private handleBackendEvent(inner: Record<string, any>, delegationId: string | undefined): void {
    const type: string = inner.type ?? '';
    if (type === 'response.output_item.done' && inner.item?.type === 'function_call') {
      const item = inner.item;
      const callId: string = item.call_id ?? item.id ?? `call_${Date.now()}`;
      if (this.seenCalls.has(callId)) return;
      this.seenCalls.add(callId);
      if (this.seenCalls.size > 1000) this.seenCalls.delete(this.seenCalls.values().next().value!);
      this.emit('toolCall', {
        id: callId,
        name: item.name,
        argumentsJson: typeof item.arguments === 'string' ? item.arguments : '{}',
        responseId: delegationId,
        itemId: item.id,
      });
      return;
    }
    if (type === 'response.completed' || type === 'response.done') {
      const usage = normalizeUsage(inner.response?.usage);
      if (usage) this.emit('usage', usage);
      return;
    }
    if (type === 'response.failed' || type === 'response.incomplete') {
      this.logger.warn('gpt-live backend response did not complete', { type, delegationId, error: inner.response?.error });
    }
  }

  // ---- utterances (synthesized response boundaries) -----------------------

  private beginUtterance(): void {
    this.currentUtteranceId = `live_utt_${++this.utteranceCounter}`;
    this.lastUtteranceId = this.currentUtteranceId;
    this.emit('responseStarted', { responseId: this.currentUtteranceId });
  }

  private endUtterance(): void {
    this.clearGateStall();
    const id = this.currentUtteranceId;
    this.currentUtteranceId = null;
    if (id) this.emit('responseDone', { responseId: id });
  }

  /** The stream is real-time: no delta for a quiet window means it stalled — close the utterance. */
  private armGateStall(): void {
    this.clearGateStall();
    const quietMs = this.config.speechGate?.quietMs ?? DEFAULT_GATE_QUIET_MS;
    this.gateStallTimer = setTimeout(() => {
      this.gateStallTimer = null;
      if (this.gate.close()) this.endUtterance();
    }, quietMs + GATE_STALL_EXTRA_MS);
    this.gateStallTimer.unref?.();
  }

  private clearGateStall(): void {
    if (this.gateStallTimer) {
      clearTimeout(this.gateStallTimer);
      this.gateStallTimer = null;
    }
  }

  private finishUtteranceOnClose(): void {
    this.clearGateStall();
    if (this.gate.close()) this.endUtterance();
    this.inputTranscript.flush();
    this.outputTranscript.flush();
  }

  private resetUtteranceState(): void {
    this.clearGateStall();
    this.gate.close();
    this.currentUtteranceId = null;
    this.lastUtteranceId = null;
    this.seenCalls.clear();
  }

  // ---- appends + acks -------------------------------------------------------

  /** Send `content` as one or more appends (500-token cap); resolves with the last chunk's ack. */
  private async append(type: AppendType, content: string, delegationId: string | null = null): Promise<boolean> {
    if (!this.isConnected) return false;
    const chunks = splitForAppend(content);
    if (chunks.length > 1) {
      this.logger.warn('gpt-live: append split to respect the 500-token cap', { type, chunks: chunks.length });
    }
    let acked = false;
    for (const chunk of chunks) {
      const eventId = nextEventId('append');
      const ack = this.awaitAck(eventId, ACK_TYPES[type]!);
      this.send({ type, event_id: eventId, delegation_id: delegationId, content: chunk });
      acked = await ack;
      if (!acked) break;
    }
    return acked;
  }

  private awaitAck(eventId: string, ackType: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.acks.delete(eventId)) {
          this.logger.warn('gpt-live: no acknowledgement for client event', { eventId, ackType });
          resolve(false);
        }
      }, this.config.ackTimeoutMs ?? 5000);
      timer.unref?.();
      this.acks.set(eventId, { ackType, resolve, timer });
    });
  }

  private resolveAck(clientEventId: unknown, acked: boolean): void {
    if (typeof clientEventId !== 'string') return;
    const waiter = this.acks.get(clientEventId);
    if (!waiter) return;
    this.acks.delete(clientEventId);
    clearTimeout(waiter.timer);
    waiter.resolve(acked);
  }

  private failPendingAcks(): void {
    for (const [id, waiter] of this.acks) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
      this.acks.delete(id);
    }
  }

  // ---- plumbing --------------------------------------------------------------

  private sessionConfig(): GptLiveSessionConfig {
    return {
      defaultVoice: this.config.voice,
      delegation: this.config.delegation,
      store: this.config.store,
      extraSessionOptions: this.config.extraSessionOptions,
      historyMaxMessages: this.config.historyMaxMessages,
      historyMaxChars: this.config.historyMaxChars,
    };
  }

  private isRetriableClose(code: number): boolean {
    if (this.intentionalClose) return false;
    if (NON_RETRIABLE_CLOSE_CODES.has(code)) return false;
    // The server closed the session deliberately: a fresh session is only
    // worth it when time ran out (expired) or the link died mid-call.
    const reason = this.sessionClosed?.reason;
    if (reason && reason !== 'expired' && reason !== 'connection_lost') return false;
    return true;
  }

  private parseEvent(raw: WebSocket.RawData): Record<string, any> | null {
    try {
      return JSON.parse(raw.toString());
    } catch {
      this.logger.warn('unparseable provider frame');
      return null;
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/** Split on whitespace so no chunk exceeds the per-append cap. */
export function splitForAppend(content: string, maxChars = APPEND_MAX_CHARS): string[] {
  const text = content.trim();
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars / 2) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

export type { ProviderUsage };
