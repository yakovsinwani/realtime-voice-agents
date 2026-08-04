/**
 * Gain application on μ-law frames, used for background-audio fades and volume.
 * μ-law is logarithmic, so gain must ramp in the linear domain:
 * decode → scale → re-encode.
 */

import { mulawDecodeSample, mulawEncodeSample } from './mulaw.js';

/** Scale an entire μ-law frame by a constant linear gain. */
export function scaleMulaw(frame: Uint8Array, gain: number): Uint8Array {
  if (gain === 1) return frame;
  const out = new Uint8Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    out[i] = mulawEncodeSample(clamp16(mulawDecodeSample(frame[i]!) * gain));
  }
  return out;
}

/**
 * Apply a linearly interpolated gain ramp across a μ-law frame
 * (`startGain` at the first sample → `endGain` at the last).
 */
export function fadeMulaw(frame: Uint8Array, startGain: number, endGain: number): Uint8Array {
  if (startGain === endGain) return scaleMulaw(frame, startGain);
  const out = new Uint8Array(frame.length);
  const step = frame.length > 1 ? (endGain - startGain) / (frame.length - 1) : 0;
  for (let i = 0; i < frame.length; i++) {
    const gain = startGain + step * i;
    out[i] = mulawEncodeSample(clamp16(mulawDecodeSample(frame[i]!) * gain));
  }
  return out;
}

function clamp16(v: number): number {
  const r = Math.round(v);
  if (r > 32767) return 32767;
  if (r < -32768) return -32768;
  return r;
}
