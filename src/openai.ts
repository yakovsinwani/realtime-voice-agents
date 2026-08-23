/** OpenAI Realtime provider (GA API) — `realtime-voice-agents/openai`. */

import { resolveApiKey } from './internal/env.js';
import type { ProviderFactory, VadConfig } from './providers/base/BaseRealtimeProvider.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderConfig,
} from './providers/openai-compatible/OpenAICompatibleProvider.js';

/** Env vars checked (in order) when no explicit apiKey is passed. */
export const OPENAI_KEY_ENV_VARS = ['OPENAI_API_KEY', 'OPENAI_KEY', 'OPEN_AI_API_KEY'] as const;

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
  /** Defaults to the first of OPENAI_API_KEY / OPENAI_KEY / OPEN_AI_API_KEY set in the env. */
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

/**
 * Create a provider factory for the bridge (`provider: openaiRealtime({...})`).
 *
 * Credentials are resolved per call, when the factory runs — not while the
 * config is being built. A missing key therefore fails THAT provider's
 * connect (with a clear error) instead of crashing config construction, so a
 * fallback chain (`BridgeConfig.fallbacks`) can absorb it.
 */
export function openaiRealtime(options: OpenAIRealtimeOptions = {}): ProviderFactory {
  const config: Omit<OpenAICompatibleProviderConfig, 'apiKey'> = {
    model: options.model ?? OPENAI_DEFAULT_MODEL,
    voice: options.voice ?? OPENAI_DEFAULT_VOICE,
    baseUrl: options.baseUrl,
    defaultVad: options.vad,
    defaultTranscription: options.transcription,
    headers: options.headers,
    extraSessionOptions: options.sessionOptions,
    connectTimeoutMs: options.connectTimeoutMs,
    providerName: 'openai',
    capabilityOverrides: {
      // OpenAI GA server_vad: threshold defaults to 0.5, range 0–1
      // (platform.openai.com/docs/guides/realtime-vad). Declared here rather
      // than in the generic compatible provider so other OpenAI-compatible
      // services don't silently inherit OpenAI's envelope.
      vadTuning: { defaultServerThreshold: 0.5, minServerThreshold: 0, maxServerThreshold: 1 },
    },
  };
  return ({ logger }) => {
    const apiKey = resolveApiKey(options.apiKey, OPENAI_KEY_ENV_VARS);
    if (!apiKey) {
      throw new Error(
        `openaiRealtime: apiKey missing (pass apiKey or set one of ${OPENAI_KEY_ENV_VARS.join('/')})`,
      );
    }
    return new OpenAICompatibleProvider({ ...config, apiKey }, logger);
  };
}

export {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderConfig,
} from './providers/openai-compatible/OpenAICompatibleProvider.js';
export { buildSessionUpdate, buildTurnDetection } from './providers/openai-compatible/session-config.js';
