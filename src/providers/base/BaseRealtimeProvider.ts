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
  /** Mid-session config change (instructions/tools/voice) where supported. */
  abstract updateSession(patch: Partial<ProviderSessionInit>): Promise<void>;
  /** Interrupt in-flight generation (where the wire protocol supports it). */
  cancelResponse(): void {}
  /** Trim the last assistant item to what the caller actually heard. */
  truncatePlayback(_itemId: string, _audioEndMs: number): void {}
}

export interface ProviderFactoryContext {
  logger: Logger;
  callSid: string;
}

/** A fresh provider per call; connection config is captured in the factory closure. */
export type ProviderFactory = (context: ProviderFactoryContext) => BaseRealtimeProvider;
