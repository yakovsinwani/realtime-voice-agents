/** OpenAI GPT-Live provider (full-duplex Live API) — `realtime-voice-agents/gpt-live`. */

import { resolveApiKey } from './internal/env.js';
import type { ProviderFactory } from './providers/base/BaseRealtimeProvider.js';
import {
  GptLiveProvider,
  type GptLiveProviderConfig,
} from './providers/gpt-live/GptLiveProvider.js';
import type { GptLiveDelegationOptions } from './providers/gpt-live/session-config.js';
import type { SpeechGateOptions } from './providers/gpt-live/speech-gate.js';

/** Env vars checked (in order) when no explicit apiKey is passed — the same project key as Realtime. */
export const GPT_LIVE_KEY_ENV_VARS = ['OPENAI_API_KEY', 'OPENAI_KEY', 'OPEN_AI_API_KEY'] as const;

export const GPT_LIVE_DEFAULT_MODEL = 'gpt-live-1';
export const GPT_LIVE_DEFAULT_VOICE = 'marin';

/** Built-in voices accepted by the Live API (the SDK's enum, Sept 2026). */
export const GPT_LIVE_VOICES = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'beacon',
  'bossa',
  'cinder',
  'coral',
  'delta',
  'echo',
  'gleam',
  'meridian',
  'quartz',
  'ripple',
  'sage',
  'shimmer',
  'stone',
  'tempo',
  'verse',
  'vesper',
  'willow',
] as const;
export type GptLiveVoice = (typeof GPT_LIVE_VOICES)[number];

export interface GptLiveOptions {
  /** Defaults to the first of OPENAI_API_KEY / OPENAI_KEY / OPEN_AI_API_KEY set in the env. */
  apiKey?: string;
  /** Live model id. Default `gpt-live-1`. */
  model?: string;
  /** Default voice when the Agent doesn't set one. Default `marin`. Immutable per session. */
  voice?: string;
  /**
   * The backend half of the prompt: the Responses model that reasons and calls
   * the agent's tools while the voice model keeps the conversation going.
   * `instructions` here are the procedures; the Agent's `instructions` are
   * the voice (style, interruption policy, when to delegate).
   */
  delegation?: GptLiveDelegationOptions;
  /** Override the WS endpoint (proxies, Azure Foundry `…/openai/v1/live`). */
  baseUrl?: string;
  /** Extra WS headers. */
  headers?: Record<string, string>;
  /** Store the session server-side (30 days) for recording download / forking. Default false. */
  store?: boolean;
  /** Provider-native `session.start` fields, deep-merged last. The schema is strict: an unknown field rejects the session. */
  sessionOptions?: Record<string, unknown>;
  connectTimeoutMs?: number;
  /**
   * Cushion held at the start of each utterance before audio is forwarded to
   * Twilio. The model streams at exactly real-time pace, so without it any
   * delivery hiccup is an audible gap; with it Twilio stays that far ahead of
   * playout. Costs the same amount of latency on each turn's first word.
   * Default 200; 0 forwards every delta as it arrives.
   */
  playoutLeadMs?: number;
  /** Speech gate tuning — utterance boundaries synthesized from the continuous output stream. */
  speechGate?: SpeechGateOptions;
  /** Session-timeline gap that splits transcript fragments into turns. Default 800. */
  transcriptGapMs?: number;
}

/**
 * Create a GPT-Live provider factory for the bridge (`provider: gptLive({...})`).
 *
 * Credentials are resolved per call, when the factory runs (see
 * `openaiRealtime` — a missing key fails that call's connect so a fallback
 * chain can absorb it instead of crashing config construction).
 */
export function gptLive(options: GptLiveOptions = {}): ProviderFactory {
  const config: Omit<GptLiveProviderConfig, 'apiKey'> = {
    model: options.model ?? GPT_LIVE_DEFAULT_MODEL,
    voice: options.voice ?? GPT_LIVE_DEFAULT_VOICE,
    delegation: options.delegation,
    baseUrl: options.baseUrl,
    headers: options.headers,
    store: options.store,
    extraSessionOptions: options.sessionOptions,
    connectTimeoutMs: options.connectTimeoutMs,
    playoutLeadMs: options.playoutLeadMs,
    speechGate: options.speechGate,
    transcriptGapMs: options.transcriptGapMs,
  };
  return ({ logger }) => {
    const apiKey = resolveApiKey(options.apiKey, GPT_LIVE_KEY_ENV_VARS);
    if (!apiKey) {
      throw new Error(`gptLive: apiKey missing (pass apiKey or set one of ${GPT_LIVE_KEY_ENV_VARS.join('/')})`);
    }
    return new GptLiveProvider({ ...config, apiKey }, logger);
  };
}

export {
  GptLiveProvider,
  GPT_LIVE_DEFAULT_BASE_URL,
  DEFAULT_PLAYOUT_LEAD_MS,
  splitForAppend,
  type GptLiveProviderConfig,
} from './providers/gpt-live/GptLiveProvider.js';
export {
  buildSessionStart,
  buildDelegation,
  buildHistoryItems,
  GPT_LIVE_AUDIO_FORMAT,
  GPT_LIVE_DEFAULT_BACKEND_MODEL,
  type GptLiveDelegationOptions,
  type GptLiveSessionConfig,
} from './providers/gpt-live/session-config.js';
export {
  SpeechGate,
  DEFAULT_GATE_QUIET_MS,
  DEFAULT_GATE_THRESHOLD_RMS,
  type SpeechGateOptions,
} from './providers/gpt-live/speech-gate.js';
