/**
 * G.711 μ-law codec (the format Twilio Media Streams speak: 8 kHz, 1 byte/sample).
 *
 * Decode uses a 256-entry lookup table; encode uses the canonical Sun g711.c
 * algorithm (bias 0x84, clip 32635). μ-law silence is 0xFF.
 */

/** One byte of μ-law silence (encodes linear 0). */
export const MULAW_SILENCE_BYTE = 0xff;

/** Samples per second on the Twilio media stream. μ-law is 1 byte per sample. */
export const MULAW_SAMPLE_RATE = 8000;

/** Bytes per 20 ms Twilio media frame at 8 kHz μ-law. */
export const MULAW_FRAME_BYTES_20MS = 160;

function decodeSampleUncached(byte: number): number {
  const u = ~byte & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? 0x84 - t : t - 0x84;
}

const DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) DECODE_TABLE[i] = decodeSampleUncached(i);

const BIAS = 0x84;
const CLIP = 32635;

/** Decode a single μ-law byte to a linear PCM16 sample. */
export function mulawDecodeSample(byte: number): number {
  return DECODE_TABLE[byte & 0xff]!;
}

/** Encode a single linear PCM16 sample to a μ-law byte. */
export function mulawEncodeSample(sample: number): number {
  let pcm = sample;
  const sign = pcm < 0 ? 0x80 : 0;
  if (sign) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  // Segment number = position of the highest set bit above bit 7 (0..7).
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode a μ-law buffer to linear PCM16 samples. */
export function mulawToPcm16(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) out[i] = DECODE_TABLE[mulaw[i]!]!;
  return out;
}

/** Encode linear PCM16 samples to a μ-law buffer. */
export function pcm16ToMulaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = mulawEncodeSample(pcm[i]!);
  return out;
}

/** Duration in milliseconds of a μ-law byte count at 8 kHz (1 byte = 125 µs). */
export function mulawBytesToMs(bytes: number): number {
  return (bytes / MULAW_SAMPLE_RATE) * 1000;
}

/** Byte length of a base64 string without decoding it. */
export function base64ByteLength(base64: string): number {
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return (base64.length * 3) / 4 - padding;
}
