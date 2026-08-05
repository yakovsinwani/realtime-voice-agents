/**
 * Provider for the OpenAI Realtime API (GA protocol) and API-compatible
 * services (xAI Grok Voice Agent). Speaks `audio/pcmu` in both directions, so
 * Twilio payloads pass through verbatim — zero transcoding on this path.
 *
 * Connect handshake: open WS → receive `session.created` → send
 * `session.update` (audio/pcmu, VAD, tools, instructions) → resolve on
 * `session.updated`. A handshake that hangs rejects after `connectTimeoutMs`
 * so a dead upstream can't leak half-open calls.
 */

import WebSocket from 'ws';
import type { Logger } from '../../logging/logger.js';
import { noopLogger } from '../../logging/logger.js';
import {
  BaseRealtimeProvider,
  type ProviderSessionInit,
  type SendTextOptions,
  type SendToolResultOptions,
  type VadConfig,
} from '../base/BaseRealtimeProvider.js';
import type { ProviderCapabilities } from '../base/capabilities.js';
import type { ProviderUsage } from '../base/events.js';
import { buildSessionUpdate } from './session-config.js';

export interface OpenAICompatibleProviderConfig {
  apiKey: string;
  model: string;
  /** WS endpoint; `?model=` is appended. Default OpenAI's realtime endpoint. */
  baseUrl?: string;
  voice?: string;
  /** VAD used when the session init doesn't specify one. `null` disables. */
  defaultVad?: VadConfig | null;
  /** Transcription used when the session init doesn't specify one. */
  defaultTranscription?: { model?: string; language?: string } | false;
  headers?: Record<string, string>;
  /** Provider-native session fields, deep-merged into session.update last. */
  extraSessionOptions?: Record<string, unknown>;
  connectTimeoutMs?: number;
  capabilityOverrides?: Partial<ProviderCapabilities>;
  /** Provider display name for logs/events (e.g. 'openai', 'xai'). */
  providerName?: string;
  /**
   * Session payload builder override for OpenAI-compatible services whose
   * session shape diverges (xAI puts voice/turn_detection at the session
   * root). Defaults to the OpenAI GA builder.
   */
  buildSession?: (
    init: ProviderSessionInit,
    config: { defaultVoice?: string; extraSessionOptions?: Record<string, unknown> },
  ) => Record<string, unknown>;
}

const DEFAULT_BASE_URL = 'wss://api.openai.com/v1/realtime';

/** A response.create waiting for the active response to finish. `attempts`
 * bounds the raced-create retry so a confused server can't cause a loop. */
interface PendingResponseCreate {
  instructions?: string;
  attempts: number;
}

/** WS close codes where retrying cannot help (protocol/auth/policy failures). */
const NON_RETRIABLE_CLOSE_CODES = new Set([1002, 1003, 1007, 1008]);

export class OpenAICompatibleProvider extends BaseRealtimeProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  private readonly config: OpenAICompatibleProviderConfig;
  private readonly logger: Logger;
  private ws: WebSocket | null = null;
  private sessionInit: ProviderSessionInit | null = null;
  private ready = false;
  private intentionalClose = false;
  private currentResponseId: string | null = null;
  /**
   * response.create serialization. The GA API rejects a `response.create`
   * issued while another response is in flight
   * (`conversation_already_has_active_response`), so creates requested
   * mid-response wait in a single pending slot and fire on `response.done`.
   * Later requests coalesce into that slot — one response reads the whole
   * conversation state, so only the instructions payload is worth keeping.
   */
  private responseActive = false;
  private pendingCreate: PendingResponseCreate | null = null;
  private lastCreateSent: PendingResponseCreate | null = null;

  constructor(config: OpenAICompatibleProviderConfig, logger: Logger = noopLogger) {
    super();
    this.config = config;
    this.logger = logger;
    this.name = config.providerName ?? 'openai';
    this.capabilities = {
      truncate: true,
      sessionUpdate: true,
      voiceChangeMidSession: false,
      transcodeRequired: false,
      resumption: false,
      agentTranscriptDeltas: true,
      vadInterruptControl: true,
      ...config.capabilityOverrides,
    };
  }

  get isConnected(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(init: ProviderSessionInit): Promise<void> {
    if (this.ws) await this.close();
    let vad = init.vad !== undefined ? init.vad : this.config.defaultVad;
    // Bridge-owned barge-in: the server must NOT auto-cancel the active
    // response on speech onset, or a guard-blocked interruption still kills
    // the sentence mid-air. An explicit vad.interruptResponse wins.
    if (init.bridgeOwnsInterruptions && this.capabilities.vadInterruptControl && vad !== null) {
      vad = { interruptResponse: false, ...(vad ?? { type: 'server' }) };
    }
    this.sessionInit = {
      ...init,
      vad,
      transcription:
        init.transcription !== undefined ? init.transcription : this.config.defaultTranscription,
    };
    this.intentionalClose = false;
    this.ready = false;
    this.responseActive = false;
    this.pendingCreate = null;
    this.lastCreateSent = null;
    this.currentResponseId = null;

    const url = `${this.config.baseUrl ?? DEFAULT_BASE_URL}?model=${encodeURIComponent(this.config.model)}`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        ...this.config.headers,
      },
      // Realtime audio: per-message zlib adds latency jitter (ws inflates every
      // delta through its async zlib queue) for negligible gain on base64 μ-law.
      perMessageDeflate: false,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timeoutMs = this.config.connectTimeoutMs ?? 10_000;
      const timer = setTimeout(() => {
        fail(new Error(`${this.name} session not ready within ${timeoutMs}ms`));
      }, timeoutMs);
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

      ws.on('open', () => this.emit('open'));
      ws.on('message', (raw) => {
        const event = this.parseEvent(raw);
        if (!event) return;
        if (!settled) {
          if (event.type === 'session.created') {
            this.send(this.buildSessionPayload());
            return;
          }
          if (event.type === 'session.updated') {
            settled = true;
            clearTimeout(timer);
            this.ready = true;
            resolve();
            return;
          }
          if (event.type === 'error') {
            fail(new Error(`${this.name} session setup error: ${JSON.stringify(event.error ?? event)}`));
            return;
          }
        }
        this.handleEvent(event);
      });
      ws.on('error', (error) => {
        if (!settled) fail(error instanceof Error ? error : new Error(String(error)));
        else this.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf?.toString();
        this.ready = false;
        if (!settled) {
          fail(new Error(`${this.name} socket closed during setup (${code} ${reason ?? ''})`));
          return;
        }
        this.emit('close', {
          code,
          reason,
          retriable: !this.intentionalClose && !NON_RETRIABLE_CLOSE_CODES.has(code),
        });
      });
    });
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.ready = false;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1000);
      timer.unref?.();
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        ws.close(1000);
      } catch {
        clearTimeout(timer);
        ws.terminate();
        resolve();
      }
    });
  }

  sendAudio(base64Mulaw: string): void {
    if (!this.isConnected) return;
    this.send({ type: 'input_audio_buffer.append', audio: base64Mulaw });
  }

  sendText(text: string, options: SendTextOptions = {}): void {
    const role = options.role ?? 'user';
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role,
        // Assistant items carry output_text content; user/system carry input_text.
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
      },
    });
    if (options.triggerResponse !== false) this.createResponse();
  }

  sendToolResult(callId: string, output: unknown, options: SendToolResultOptions = {}): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: typeof output === 'string' ? output : JSON.stringify(output ?? null),
      },
    });
    if (options.triggerResponse !== false) this.createResponse();
  }

  createResponse(options: { instructions?: string } = {}): void {
    if (this.responseActive) {
      // Coalesce: explicit instructions win over (and survive) a bare
      // "respond now" — the eventual response covers all requests.
      this.pendingCreate = {
        instructions: options.instructions ?? this.pendingCreate?.instructions,
        attempts: 0,
      };
      return;
    }
    this.sendCreate({ instructions: options.instructions, attempts: 0 });
  }

  private sendCreate(create: PendingResponseCreate): void {
    this.lastCreateSent = create;
    this.send({
      type: 'response.create',
      ...(create.instructions ? { response: { instructions: create.instructions } } : {}),
    });
  }

  async updateSession(patch: Partial<ProviderSessionInit>): Promise<void> {
    if (!this.sessionInit) throw new Error('updateSession before connect');
    this.sessionInit = { ...this.sessionInit, ...patch };
    this.send(this.buildSessionPayload());
  }

  private buildSessionPayload(): Record<string, unknown> {
    const builder = this.config.buildSession ?? buildSessionUpdate;
    return builder(this.sessionInit!, {
      defaultVoice: this.config.voice,
      extraSessionOptions: this.config.extraSessionOptions,
    });
  }

  override cancelResponse(): void {
    // A pending bare "respond now" is stale once the turn is being killed;
    // pending instructions (goodbye, announcement) must still fire.
    if (this.pendingCreate && !this.pendingCreate.instructions) this.pendingCreate = null;
    this.send({ type: 'response.cancel' });
  }

  override truncatePlayback(itemId: string, audioEndMs: number): void {
    this.send({
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.round(audioEndMs)),
    });
  }

  // ---- inbound events ------------------------------------------------------

  private handleEvent(event: Record<string, any>): void {
    switch (event.type) {
      case 'response.created': {
        const responseId = event.response?.id ?? `resp_${Date.now()}`;
        this.currentResponseId = responseId;
        this.responseActive = true;
        this.emit('responseStarted', { responseId });
        break;
      }
      case 'response.output_item.added': {
        const itemId = event.item?.id;
        if (itemId) {
          this.emit('outputItemAdded', {
            itemId,
            responseId: event.response_id ?? this.currentResponseId ?? '',
          });
        }
        break;
      }
      case 'response.output_audio.delta': {
        if (typeof event.delta === 'string' && event.delta.length > 0) {
          this.emit('audio', {
            base64Mulaw: event.delta,
            responseId: event.response_id ?? this.currentResponseId ?? '',
            itemId: event.item_id,
          });
        }
        break;
      }
      case 'response.output_audio_transcript.delta': {
        if (typeof event.delta === 'string') {
          this.emit('agentTranscriptDelta', {
            responseId: event.response_id ?? this.currentResponseId ?? '',
            delta: event.delta,
          });
        }
        break;
      }
      case 'response.output_audio_transcript.done': {
        if (typeof event.transcript === 'string') {
          this.emit('agentTranscript', {
            responseId: event.response_id ?? this.currentResponseId ?? '',
            text: event.transcript,
          });
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        if (typeof event.transcript === 'string' && event.transcript.trim().length > 0) {
          this.emit('userTranscript', { text: event.transcript.trim() });
        }
        break;
      }
      case 'input_audio_buffer.speech_started':
        // The caller is talking: their turn will trigger the next response, so
        // a pending bare create is stale (firing it would talk over them).
        // Pending instructions (goodbye, nudge) survive.
        if (this.pendingCreate && !this.pendingCreate.instructions) this.pendingCreate = null;
        this.emit('userSpeechStarted');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit('userSpeechStopped');
        break;
      case 'response.done': {
        const responseId = event.response?.id ?? this.currentResponseId ?? '';
        const usage = normalizeUsage(event.response?.usage);
        this.responseActive = false;
        // Flush before emitting: the pending create predates whatever the
        // session's responseDone listeners decide to send next.
        const pending = this.pendingCreate;
        if (pending) {
          this.pendingCreate = null;
          this.sendCreate(pending);
        }
        if (usage) this.emit('usage', usage);
        this.emit('responseDone', { responseId, usage: usage ?? undefined });
        break;
      }
      case 'response.function_call_arguments.done': {
        this.emit('toolCall', {
          id: event.call_id ?? event.item_id ?? `call_${Date.now()}`,
          name: event.name,
          argumentsJson: typeof event.arguments === 'string' ? event.arguments : '{}',
          responseId: event.response_id ?? this.currentResponseId ?? undefined,
          itemId: event.item_id,
        });
        break;
      }
      case 'error': {
        const code = event.error?.code;
        if (code === 'conversation_already_has_active_response') {
          // Our create raced a server-created response (VAD turn) — the call
          // is healthy; the response we asked for just never started. Re-arm
          // it (bounded) to fire when the active one completes.
          this.responseActive = true;
          const last = this.lastCreateSent;
          if (last && last.attempts < 2 && !this.pendingCreate) {
            this.pendingCreate = { ...last, attempts: last.attempts + 1 };
          }
          this.logger.warn('response.create raced an active response; deferred until it completes', {
            error: event.error,
          });
          break;
        }
        if (code === 'response_cancel_not_active') {
          // Cancel raced response.done — nothing left to interrupt.
          this.logger.warn('response.cancel raced completion (ignored)', { error: event.error });
          break;
        }
        this.logger.warn('provider error event', { error: event.error });
        this.emit('error', new Error(`${this.name} error: ${JSON.stringify(event.error ?? event)}`));
        break;
      }
      default:
        break;
    }
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

export function normalizeUsage(raw: any): ProviderUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const inputDetails = raw.input_token_details ?? raw.input_tokens_details;
  const outputDetails = raw.output_token_details ?? raw.output_tokens_details;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    totalTokens: raw.total_tokens ?? (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0),
    ...(inputDetails
      ? {
          inputTokenDetails: {
            textTokens: inputDetails.text_tokens,
            audioTokens: inputDetails.audio_tokens,
            cachedTokens: inputDetails.cached_tokens,
          },
        }
      : {}),
    ...(outputDetails
      ? {
          outputTokenDetails: {
            textTokens: outputDetails.text_tokens,
            audioTokens: outputDetails.audio_tokens,
          },
        }
      : {}),
    raw,
  };
}
