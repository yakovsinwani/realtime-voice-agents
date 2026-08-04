/**
 * Background-audio sources. Presets resolve to bundled μ-law loop assets;
 * custom sources accept a μ-law buffer or a file path to one.
 * (The playback engine lands with the background-audio milestone; the types
 * live here so tool definitions can reference them.)
 */

export type BackgroundAudioPreset =
  | 'elevator-jazz'
  | 'lofi'
  | 'keyboard-typing'
  | 'thinking-hum'
  | 'ringing';

export type BackgroundAudioSpec =
  | BackgroundAudioPreset
  | {
      /** Raw 8 kHz μ-law audio, or an absolute path to a `.ulaw` file. */
      custom: Buffer | string;
    };

export interface BackgroundAudioOptions {
  /** Linear gain 0..1 applied to the loop. Default 0.4. */
  volume?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  /** Delay before audio actually starts — fast tools never trigger it. */
  startDelayMs?: number;
  /** Hard stop even if never released. Default 60000. */
  maxDurationMs?: number;
}
