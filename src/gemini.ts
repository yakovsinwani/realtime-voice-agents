/** Google Gemini Live provider — `twilio-realtime-agents/gemini`. */

import type { ProviderFactory, VadConfig } from './providers/base/BaseRealtimeProvider.js';
import {
  GeminiLiveProvider,
  type GeminiLiveProviderConfig,
  type GeminiLiveConnector,
  type GeminiLiveSessionLike,
  type GeminiConnectParams,
} from './providers/gemini/GeminiLiveProvider.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
export const GEMINI_DEFAULT_VOICE = 'Aoede';
export const GEMINI_VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Puck'] as const;

export interface GeminiLiveOptions {
  /** Google AI Studio key. Defaults to process.env.GOOGLE_API_KEY / GEMINI_API_KEY. */
  apiKey?: string;
  /** Vertex AI instead of API-key auth (Application Default Credentials). */
  vertex?: { project: string; location: string };
  model?: string;
  voice?: string;
  /** BCP-47 speech language (e.g. 'en-US'). */
  languageCode?: string;
  /** Normalized VAD (start/end sensitivity, padding, silence). `null` disables. */
  vad?: VadConfig | null;
  /** Caller/agent transcription toggles. Default both on. */
  transcription?: { input?: boolean; output?: boolean } | false;
  /** Session resumption across reconnects. Default true. */
  resumption?: boolean;
  /** Sliding-window context compression for long calls. Default false. */
  contextWindowCompression?: boolean;
  /** Provider-native live config, deep-merged last (escape hatch). */
  config?: Record<string, unknown>;
  connectTimeoutMs?: number;
  /** Test seam: replaces the @google/genai live connection. */
  connector?: GeminiLiveConnector;
}

/** Create a Gemini Live provider factory for the bridge. */
export function geminiLive(options: GeminiLiveOptions = {}): ProviderFactory {
  const apiKey = options.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey && !options.vertex && !options.connector) {
    throw new Error(
      'geminiLive: credentials missing (pass apiKey, set GOOGLE_API_KEY/GEMINI_API_KEY, or configure vertex)',
    );
  }
  const config: GeminiLiveProviderConfig = {
    apiKey,
    vertex: options.vertex,
    model: options.model ?? GEMINI_DEFAULT_MODEL,
    voice: options.voice ?? GEMINI_DEFAULT_VOICE,
    languageCode: options.languageCode,
    defaultVad: options.vad,
    transcription: options.transcription,
    resumption: options.resumption,
    contextWindowCompression: options.contextWindowCompression,
    extraConfig: options.config,
    connectTimeoutMs: options.connectTimeoutMs,
    connector: options.connector,
  };
  return ({ logger }) => new GeminiLiveProvider(config, logger);
}

export {
  GeminiLiveProvider,
  type GeminiLiveProviderConfig,
  type GeminiLiveConnector,
  type GeminiLiveSessionLike,
  type GeminiConnectParams,
};
