/**
 * xAI Grok Voice Agent provider — `twilio-realtime-agents/xai`.
 *
 * The Voice Agent API is OpenAI-Realtime-compatible on the wire (GA event
 * names, `audio/pcmu` at 8 kHz supported → zero transcoding), with a slightly
 * different session shape: `voice` and `turn_detection` live at the session
 * root, audio formats carry an explicit `rate`, and transcription is
 * configured via `language_hint`/`keyterms`.
 * Docs: https://docs.x.ai/developers/model-capabilities/audio/voice-agent
 */

import { deepMerge } from './internal/merge.js';
import type { ProviderFactory, ProviderSessionInit, VadConfig } from './providers/base/BaseRealtimeProvider.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderConfig,
} from './providers/openai-compatible/OpenAICompatibleProvider.js';
import { buildTurnDetection } from './providers/openai-compatible/session-config.js';

export const XAI_BASE_URL = 'wss://api.x.ai/v1/realtime';
/** Alias tracking xAI's flagship voice model. */
export const XAI_DEFAULT_MODEL = 'grok-voice-latest';
export const XAI_DEFAULT_VOICE = 'eve';

export interface XaiRealtimeOptions {
  /** Defaults to process.env.XAI_API_KEY. */
  apiKey?: string;
  /** `grok-voice-latest` (default), `grok-voice-think-fast-2.0`, … */
  model?: string;
  voice?: string;
  baseUrl?: string;
  vad?: VadConfig | null;
  /** Speech-recognition hints. `false` omits transcription config. */
  transcription?: { languageHint?: string; keyterms?: string[] } | false;
  headers?: Record<string, string>;
  /** Provider-native session fields, deep-merged last (escape hatch). */
  sessionOptions?: Record<string, unknown>;
  connectTimeoutMs?: number;
}

/** xAI session.update: GA-style nested audio, voice/turn_detection at root. */
export function buildXaiSessionUpdate(
  init: ProviderSessionInit,
  config: { defaultVoice?: string; extraSessionOptions?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const voice = init.voice ?? config.defaultVoice;
  const transcription = init.transcription === false ? undefined : init.transcription;
  let session: Record<string, unknown> = {
    instructions: init.instructions,
    ...(voice ? { voice } : {}),
    turn_detection: buildTurnDetection(init.vad),
    tools: (init.tools ?? []).map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters,
    })),
    audio: {
      input: {
        format: { type: 'audio/pcmu', rate: 8000 },
        ...(transcription
          ? {
              transcription: {
                ...(transcription.language ? { language_hint: transcription.language } : {}),
              },
            }
          : {}),
      },
      output: {
        format: { type: 'audio/pcmu', rate: 8000 },
      },
    },
  };
  session = deepMerge(session, init.providerOptions);
  session = deepMerge(session, config.extraSessionOptions);
  return { type: 'session.update', session };
}

/** Create an xAI Grok Voice provider factory for the bridge. */
export function xaiRealtime(options: XaiRealtimeOptions = {}): ProviderFactory {
  const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('xaiRealtime: apiKey missing (pass apiKey or set XAI_API_KEY)');
  }
  const transcription =
    options.transcription === false
      ? (false as const)
      : options.transcription
        ? { language: options.transcription.languageHint }
        : undefined;
  const config: OpenAICompatibleProviderConfig = {
    apiKey,
    model: options.model ?? XAI_DEFAULT_MODEL,
    voice: options.voice ?? XAI_DEFAULT_VOICE,
    baseUrl: options.baseUrl ?? XAI_BASE_URL,
    defaultVad: options.vad,
    defaultTranscription: transcription,
    headers: options.headers,
    extraSessionOptions: options.transcription
      ? deepMerge(
          {
            audio: {
              input: {
                transcription: {
                  ...(options.transcription.keyterms ? { keyterms: options.transcription.keyterms } : {}),
                },
              },
            },
          },
          options.sessionOptions,
        )
      : options.sessionOptions,
    connectTimeoutMs: options.connectTimeoutMs,
    providerName: 'xai',
    buildSession: buildXaiSessionUpdate,
    capabilityOverrides: {
      // conversation.item.truncate is not documented for xAI — don't send it.
      truncate: false,
      // turn_detection.interrupt_response is not documented for xAI either;
      // fallback: server-side auto-interrupt stays on, so the interruption
      // guard protects only already-buffered Twilio audio (see parity tests).
      vadInterruptControl: false,
    },
  };
  return ({ logger }) => new OpenAICompatibleProvider(config, logger);
}
