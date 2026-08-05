/**
 * session.update payload construction — GA Realtime API only.
 *
 * The single most fragile spot in Twilio↔OpenAI bridges: a rejected
 * session.update leaves the session on 24 kHz PCM defaults, which Twilio
 * renders as loud static. Keeping every field in one builder makes the wire
 * shape a single point of truth (and of fixing).
 *
 * GA shape notes (vs the old beta many tutorials still show):
 * - audio formats are MIME-style objects (`{ type: 'audio/pcmu' }`), nested
 *   under `session.audio.input/output` — not flat `input_audio_format: 'g711_ulaw'`
 * - assistant audio arrives as `response.output_audio.delta` — not
 *   `response.audio.delta`
 * - `turn_detection: null` explicitly disables server VAD
 */

import { deepMerge } from '../../internal/merge.js';
import type { ProviderSessionInit, VadConfig } from '../base/BaseRealtimeProvider.js';

export function buildTurnDetection(vad: VadConfig | null | undefined): Record<string, unknown> | null {
  if (vad === null) return null;
  const config = vad ?? { type: 'server' };
  // Only set when present in the normalized config — the bridge injects
  // interruptResponse: false via `bridgeOwnsInterruptions` on providers that
  // support it; wire defaults stay untouched otherwise.
  const shared = {
    ...(config.interruptResponse !== undefined ? { interrupt_response: config.interruptResponse } : {}),
    ...(config.createResponse !== undefined ? { create_response: config.createResponse } : {}),
  };
  if (config.type === 'semantic') {
    return {
      type: 'semantic_vad',
      ...(config.eagerness ? { eagerness: config.eagerness } : {}),
      ...shared,
    };
  }
  return {
    type: 'server_vad',
    ...(config.threshold !== undefined ? { threshold: config.threshold } : {}),
    ...(config.silenceDurationMs !== undefined ? { silence_duration_ms: config.silenceDurationMs } : {}),
    ...(config.prefixPaddingMs !== undefined ? { prefix_padding_ms: config.prefixPaddingMs } : {}),
    ...shared,
  };
}

export interface SessionPayloadConfig {
  defaultVoice?: string;
  /** Provider-native session fields, deep-merged last (escape hatch). */
  extraSessionOptions?: Record<string, unknown>;
}

export function buildSessionUpdate(
  init: ProviderSessionInit,
  config: SessionPayloadConfig = {},
): Record<string, unknown> {
  const voice = init.voice ?? config.defaultVoice;
  const transcription = init.transcription === false ? undefined : init.transcription;

  let session: Record<string, unknown> = {
    type: 'realtime',
    instructions: init.instructions,
    tools: (init.tools ?? []).map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters,
    })),
    tool_choice: 'auto',
    audio: {
      input: {
        format: { type: 'audio/pcmu' },
        turn_detection: buildTurnDetection(init.vad),
        ...(transcription
          ? {
              transcription: {
                model: transcription.model ?? 'gpt-4o-mini-transcribe',
                ...(transcription.language ? { language: transcription.language } : {}),
              },
            }
          : {}),
      },
      output: {
        format: { type: 'audio/pcmu' },
        ...(voice ? { voice } : {}),
      },
    },
  };
  session = deepMerge(session, init.providerOptions);
  session = deepMerge(session, config.extraSessionOptions);
  return { type: 'session.update', session };
}
