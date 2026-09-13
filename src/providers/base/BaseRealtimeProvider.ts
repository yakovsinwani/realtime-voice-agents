import { TypedEmitter } from '../../internal/events.js';
import type { Logger } from '../../logging/logger.js';
import type { ProviderCapabilities } from './capabilities.js';
import type { ProviderEvents } from './events.js';

/** Normalized VAD config, mapped onto each provider's native shape. */
export interface VadConfig {
  /** 'server' = provider-side VAD; 'semantic' where supported; null disables turn detection. */
  type?: 'server' | 'semantic';
  threshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  /** Semantic VAD eagerness (OpenAI). */
  eagerness?: 'low' | 'medium' | 'high' | 'auto';
  /** Gemini-only sensitivities. */
  startSensitivity?: 'high' | 'low';
  endSensitivity?: 'high' | 'low';
  /**
   * Server-side auto-cancel of the active response on speech onset (OpenAI
   * `interrupt_response`). Leave unset: the bridge manages it via
   * `bridgeOwnsInterruptions` so the interruption guard actually holds.
   */
  interruptResponse?: boolean;
  /** Server-side auto-response on turn commit (OpenAI `create_response`). */
  createResponse?: boolean;
}

/** One prior conversation turn, for providers that seed history at session start. */
export interface ProviderHistoryEntry {
  /** `developer` carries engine notes (transfer records, continuation context). */
  role: 'user' | 'assistant' | 'developer';
  text: string;
}

export interface ProviderToolSchema {
  name: string;
  description?: string;
  /** JSON Schema for the tool parameters. */
  parameters: Record<string, unknown>;
}

/** Everything a provider needs to open (or re-open) a live session. */
export interface ProviderSessionInit {
  instructions: string;
  voice?: string;
  tools?: ProviderToolSchema[];
  vad?: VadConfig | null;
  temperature?: number;
  transcription?: { model?: string; language?: string } | false;
  /** Session-resumption handle from a previous connection (capability-gated). */
  resumptionHandle?: string;
  /**
   * Force a brand-new server session: ignore any stored resumption handle.
   * Used for handoffs, where the session config itself changes.
   */
  freshSession?: boolean;
  /**
   * The bridge arbitrates barge-ins (interruption guard). Providers with
   * `vadInterruptControl` disable their server-side auto-interrupt unless the
   * vad config sets `interruptResponse` explicitly; others ignore this flag
   * (documented fallback: guard protects buffered audio only).
   */
  bridgeOwnsInterruptions?: boolean;
  /**
   * Serialize mid-session updates: one session.update in flight at a time,
   * each acknowledged (or timed out) before the next is sent. Set by the
   * bridge when noise-adaptive VAD is configured; absent/false keeps the
   * legacy fire-and-forget update behavior exactly as before.
   */
  serializedSessionUpdates?: boolean;
  /**
   * Conversation so far, oldest first, for providers that seed history into
   * the new session at connect time (capability `startupHistory`); ignored by
   * providers that re-inject history as text after connecting.
   */
  history?: ProviderHistoryEntry[];
  /** Provider-native session options, deep-merged last (escape hatch). */
  providerOptions?: Record<string, unknown>;
}

export interface SendTextOptions {
  /** `assistant` is used for history re-injection after reconnect/handoff. */
  role?: 'user' | 'system' | 'assistant';
  /** Ask the model to respond immediately after the text lands. Default true. */
  triggerResponse?: boolean;
}

export interface SendToolResultOptions {
  triggerResponse?: boolean;
}

export interface SessionUpdateOptions {
  /**
   * Resolve with the provider's acknowledgement of THIS update (`true`) rather
   * than at send time. Meaningful only with serialized session updates (see
   * `ProviderSessionInit.serializedSessionUpdates`); providers without ack
   * support resolve `false`/`void`, which callers treat as not-acknowledged.
   */
  awaitAck?: boolean;
}

/**
 * The provider contract: μ-law in, μ-law out, normalized events.
 * Transcoding (when the provider speaks PCM) lives inside the provider, so
 * the engine stays codec-free. `connect()` is re-invokable on the same
 * instance — the session layer owns reconnect policy and context re-injection.
 */
export abstract class BaseRealtimeProvider extends TypedEmitter<ProviderEvents> {
  abstract readonly name: string;
  abstract readonly capabilities: ProviderCapabilities;

  /** Resolves when the session is configured and ready for audio. */
  abstract connect(init: ProviderSessionInit): Promise<void>;
  abstract close(): Promise<void>;
  abstract get isConnected(): boolean;

  /** Forward caller audio (base64 μ-law 8 kHz). */
  abstract sendAudio(base64Mulaw: string): void;
  /** Inject a text turn into the conversation. */
  abstract sendText(text: string, options?: SendTextOptions): void;
  /** Return a tool result to the model. */
  abstract sendToolResult(callId: string, output: unknown, options?: SendToolResultOptions): void;
  /** Trigger an out-of-band assistant response (greeting, nudge, announcement). */
  abstract createResponse(options?: { instructions?: string }): void;
  /**
   * Mid-session config change (instructions/tools/voice/vad) where supported.
   * Return `true` to signal the provider ACKNOWLEDGED the update — the
   * noise-adaptive VAD auto-commit requires it. The `boolean | void` return
   * keeps existing third-party `Promise<void>` implementations compiling;
   * anything other than `true` is treated as not-acknowledged.
   */
  abstract updateSession(
    patch: Partial<ProviderSessionInit>,
    options?: SessionUpdateOptions,
  ): Promise<boolean | void>;
  /**
   * The last ACKNOWLEDGED turn-detection config on the live session — what was
   * actually sent and confirmed, never desired/pending state. Undefined until
   * the provider reports one (third-party providers may never set it).
   */
  getEffectiveVad(): VadConfig | null | undefined {
    return this.effectiveVadValue;
  }
  /** Set by subclasses when a config carrying `vad` is acknowledged. */
  protected effectiveVadValue: VadConfig | null | undefined = undefined;
  /** Interrupt in-flight generation (where the wire protocol supports it). */
  cancelResponse(): void {}
  /** Trim the last assistant item to what the caller actually heard. */
  truncatePlayback(_itemId: string, _audioEndMs: number): void {}
  /**
   * Whether the most recent connect restored server-side context (session
   * resumption). When true, the engine skips transcript re-injection.
   */
  get didResume(): boolean {
    return false;
  }
}

export interface ProviderFactoryContext {
  logger: Logger;
  callSid: string;
}

/** A fresh provider per call; connection config is captured in the factory closure. */
export type ProviderFactory = (context: ProviderFactoryContext) => BaseRealtimeProvider;
