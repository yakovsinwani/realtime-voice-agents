import { describe, expect, it } from 'vitest';
import { InboundTranscoder, OutboundTranscoder } from './transcode.js';
import { mulawToPcm16, pcm16ToMulaw } from './mulaw.js';

function sinePcm(freq: number, rate: number, samples: number, amplitude = 12000): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate));
  }
  return out;
}

function pcmToB64LE(pcm: Int16Array): string {
  const buf = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, i * 2);
  return buf.toString('base64');
}

describe('InboundTranscoder (μ-law 8k → PCM16 16k)', () => {
  it('doubles the sample count and outputs little-endian PCM16', () => {
    const t = new InboundTranscoder(16000);
    const mulaw = pcm16ToMulaw(sinePcm(440, 8000, 800));
    const out = Buffer.from(t.process(Buffer.from(mulaw).toString('base64')), 'base64');
    expect(Math.abs(out.length / 2 - 1600)).toBeLessThanOrEqual(2);
  });

  it('preserves a tone through decode + upsample (energy check)', () => {
    const t = new InboundTranscoder(16000);
    const original = sinePcm(440, 8000, 8000);
    const mulaw = pcm16ToMulaw(original);
    const out = Buffer.from(t.process(Buffer.from(mulaw).toString('base64')), 'base64');
    const pcm = new Int16Array(out.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = out.readInt16LE(i * 2);
    const rmsOf = (x: Int16Array) =>
      Math.sqrt(x.slice(500).reduce((a, v) => a + v * v, 0) / (x.length - 500));
    expect(rmsOf(pcm) / rmsOf(original)).toBeGreaterThan(0.9);
    expect(rmsOf(pcm) / rmsOf(original)).toBeLessThan(1.1);
  });
});

describe('OutboundTranscoder (PCM16 24k → μ-law 8k)', () => {
  it('reduces sample count by 3 and emits μ-law', () => {
    const t = new OutboundTranscoder(24000);
    const out = Buffer.from(t.process(pcmToB64LE(sinePcm(440, 24000, 2400))), 'base64');
    expect(Math.abs(out.length - 800)).toBeLessThanOrEqual(2);
  });

  it('carries a dangling odd byte across chunks instead of dropping it', () => {
    const pcm = sinePcm(500, 24000, 2400);
    const whole = Buffer.allocUnsafe(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) whole.writeInt16LE(pcm[i]!, i * 2);

    // Split at an odd byte offset: sample 601's low byte ends chunk 1.
    const splitAt = 1203;
    const a = whole.subarray(0, splitAt).toString('base64');
    const b = whole.subarray(splitAt).toString('base64');

    const split = new OutboundTranscoder(24000);
    const combined = Buffer.concat([
      Buffer.from(split.process(a), 'base64'),
      Buffer.from(split.process(b), 'base64'),
    ]);
    const single = Buffer.from(
      new OutboundTranscoder(24000).process(whole.toString('base64')),
      'base64',
    );
    expect(combined.length).toBe(single.length);
    expect(combined.equals(single)).toBe(true);
  });

  it('round trip 24k→8k mulaw decodes to an audible tone', () => {
    const t = new OutboundTranscoder(24000);
    const out = Buffer.from(t.process(pcmToB64LE(sinePcm(700, 24000, 24000))), 'base64');
    const decoded = mulawToPcm16(new Uint8Array(out));
    const rms = Math.sqrt(decoded.slice(500).reduce((a, v) => a + v * v, 0) / (decoded.length - 500));
    expect(rms).toBeGreaterThan(5000);
  });
});
