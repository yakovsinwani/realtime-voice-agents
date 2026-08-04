/**
 * Per-call transcoders between the Twilio wire format (base64 μ-law 8 kHz) and
 * provider PCM16 formats (Gemini: 16 kHz in, 24 kHz out).
 *
 * Both directions are stateful: the resampler carries FIR history across
 * chunks, and the outbound transcoder carries a dangling odd byte so PCM16
 * frames split mid-sample re-align instead of being truncated.
 */

import { mulawToPcm16, pcm16ToMulaw } from './mulaw.js';
import { Resampler, type ResamplerOptions } from './resampler.js';

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function pcm16ToBufferLE(pcm: Int16Array): Buffer {
  if (IS_LITTLE_ENDIAN) {
    return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  }
  const buf = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, i * 2);
  return buf;
}

function bufferLEToPcm16(buf: Buffer): Int16Array {
  const samples = buf.length >> 1;
  if (IS_LITTLE_ENDIAN && buf.byteOffset % 2 === 0) {
    return new Int16Array(buf.buffer, buf.byteOffset, samples);
  }
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = buf.readInt16LE(i * 2);
  return pcm;
}

/** Twilio → provider: base64 μ-law 8 kHz in, base64 PCM16LE at `outRate` out. */
export class InboundTranscoder {
  private readonly resampler: Resampler;

  constructor(outRate = 16000, options?: ResamplerOptions) {
    this.resampler = new Resampler(8000, outRate, options);
  }

  process(base64Mulaw: string): string {
    const mulaw = Buffer.from(base64Mulaw, 'base64');
    const pcm = mulawToPcm16(new Uint8Array(mulaw.buffer, mulaw.byteOffset, mulaw.length));
    const resampled = this.resampler.process(pcm);
    return pcm16ToBufferLE(resampled).toString('base64');
  }

  reset(): void {
    this.resampler.reset();
  }
}

/** Provider → Twilio: base64 PCM16LE at `inRate` in, base64 μ-law 8 kHz out. */
export class OutboundTranscoder {
  private readonly resampler: Resampler;
  /** Dangling byte from a chunk that split a 16-bit sample. */
  private carry: Buffer | null = null;

  constructor(inRate = 24000, options?: ResamplerOptions) {
    this.resampler = new Resampler(inRate, 8000, options);
  }

  process(base64Pcm16: string): string {
    let buf = Buffer.from(base64Pcm16, 'base64');
    if (this.carry) {
      buf = Buffer.concat([this.carry, buf]);
      this.carry = null;
    }
    if (buf.length % 2 !== 0) {
      this.carry = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
    }
    const pcm = bufferLEToPcm16(buf);
    const resampled = this.resampler.process(pcm);
    return Buffer.from(pcm16ToMulaw(resampled)).toString('base64');
  }

  reset(): void {
    this.resampler.reset();
    this.carry = null;
  }
}
