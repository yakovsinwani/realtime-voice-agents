export {
  MULAW_SILENCE_BYTE,
  MULAW_SAMPLE_RATE,
  MULAW_FRAME_BYTES_20MS,
  mulawDecodeSample,
  mulawEncodeSample,
  mulawToPcm16,
  pcm16ToMulaw,
  mulawBytesToMs,
  base64ByteLength,
} from './mulaw.js';
export { Resampler, type ResamplerOptions } from './resampler.js';
export { InboundTranscoder, OutboundTranscoder } from './transcode.js';
export { scaleMulaw, fadeMulaw } from './gain.js';
export {
  BackgroundAudioPlayer,
  type BackgroundAudioPlayerDeps,
} from './background/BackgroundAudioPlayer.js';
export { loadBackgroundAudio, isPresetName } from './background/loader.js';
export type {
  BackgroundAudioPreset,
  BackgroundAudioSpec,
  BackgroundAudioOptions,
} from './background/presets.js';
