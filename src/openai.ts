/** OpenAI Realtime provider (GA API) — `twilio-realtime-agents/openai`. */

import type { ProviderFactory, VadConfig } from './providers/base/BaseRealtimeProvider.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderConfig,
} from './providers/openai-compatible/OpenAICompatibleProvider.js';

export const OPENAI_DEFAULT_MODEL = 'gpt-realtime';
export const OPENAI_DEFAULT_VOICE = 'marin';

/**
 * Voices supported by realtime models. OpenAI recommends marin/cedar (the
 * realtime-native ones — audibly better once 8 kHz telephony takes its cut).
 * The legacy TTS voices (fable, onyx, nova) are NOT supported and fail in
 * unpleasant ways instead of erroring cleanly.
 */
export const OPENAI_REALTIME_VOICES = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
] as const;
export type OpenAIRealtimeVoice = (typeof OPENAI_REALTIME_VOICES)[number];

export interface OpenAIRealtimeOptions {
  /** Defaults to process.env.OPENAI_API_KEY. */
  apiKey?: string;
  /** Realtime model id. Default `gpt-realtime`. */
  model?: string;
  /** Default voice when the Agent doesn't set one. Default `marin`. */
  voice?: string;
  /** Override the WS endpoint (proxies, gateways). */
  baseUrl?: string;
  /** Normalized VAD config; `null` disables server turn detection. */
  vad?: VadConfig | null;
  /** Caller-speech transcription; `false` disables it. */
  transcription?: { model?: string; language?: string } | false;
  /** Extra WS headers. */
  headers?: Record<string, string>;
  /** Provider-native session fields, deep-merged into session.update last. */
  sessionOptions?: Record<string, unknown>;
  connectTimeoutMs?: number;
}

/** Create a provider factory for the bridge (`provider: openaiRealtime({...})`). */
export function openaiRealtime(options: OpenAIRealtimeOptions = {}): ProviderFactory {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('openaiRealtime: apiKey missing (pass apiKey or set OPENAI_API_KEY)');
  }
  const config: OpenAICompatibleProviderConfig = {
    apiKey,
    model: options.model ?? OPENAI_DEFAULT_MODEL,
    voice: options.voice ?? OPENAI_DEFAULT_VOICE,
    baseUrl: options.baseUrl,
    defaultVad: options.vad,
    defaultTranscription: options.transcription,
    headers: options.headers,
    extraSessionOptions: options.sessionOptions,
    connectTimeoutMs: options.connectTimeoutMs,
    providerName: 'openai',
  };
  return ({ logger }) => {
    const provider = new OpenAICompatibleProvider(config, logger);
    return provider;
  };
}

export {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderConfig,
} from './providers/openai-compatible/OpenAICompatibleProvider.js';
export { buildSessionUpdate, buildTurnDetection } from './providers/openai-compatible/session-config.js';
