import { describe, expect, it } from 'vitest';
import { Resampler } from './resampler.js';

function sine(freq: number, rate: number, samples: number, amplitude = 12000): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate));
  }
  return out;
}

function rms(x: Int16Array, from = 0): number {
  let sum = 0;
  let n = 0;
  for (let i = from; i < x.length; i++) {
    sum += x[i]! * x[i]!;
    n++;
  }
  return Math.sqrt(sum / Math.max(n, 1));
}

function concatAll(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

describe('Resampler', () => {
  it('produces bit-identical output for random chunk splits vs single pass (8k→16k)', () => {
    const input = sine(440, 8000, 4000);
    const single = new Resampler(8000, 16000).process(input);

    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const chunked = new Resampler(8000, 16000);
    const outputs: Int16Array[] = [];
    let offset = 0;
    while (offset < input.length) {
      const size = Math.max(1, Math.floor(rand() * 300));
      outputs.push(chunked.process(input.subarray(offset, Math.min(offset + size, input.length))));
      offset += size;
    }
    const combined = concatAll(outputs);

    expect(combined.length).toBe(single.length);
    expect(Array.from(combined)).toEqual(Array.from(single));
  });

  it('produces bit-identical output for random chunk splits vs single pass (24k→8k)', () => {
    const input = sine(700, 24000, 24000);
    const single = new Resampler(24000, 8000).process(input);

    const chunked = new Resampler(24000, 8000);
    const outputs: Int16Array[] = [];
    let offset = 0;
    const sizes = [1, 7, 480, 3, 960, 111, 2048];
    let i = 0;
    while (offset < input.length) {
      const size = sizes[i++ % sizes.length]!;
      outputs.push(chunked.process(input.subarray(offset, Math.min(offset + size, input.length))));
      offset += size;
    }
    const combined = concatAll(outputs);

    expect(combined.length).toBe(single.length);
    expect(Array.from(combined)).toEqual(Array.from(single));
  });

  it('passes DC through exactly', () => {
    const dc = new Int16Array(2000).fill(1234);
    const out = new Resampler(8000, 16000).process(dc);
    // After the filter warms up, DC must be preserved exactly (per-phase unit gain).
    for (let i = 200; i < out.length; i++) expect(out[i]).toBe(1234);
  });

  it('preserves an in-band tone (1 kHz through 24k→8k) with ~unity gain', () => {
    const input = sine(1000, 24000, 48000);
    const out = new Resampler(24000, 8000).process(input);
    const inRms = rms(input, 1000);
    const outRms = rms(out, 1000);
    expect(outRms / inRms).toBeGreaterThan(0.95);
    expect(outRms / inRms).toBeLessThan(1.05);
  });

  it('rejects out-of-band content (10 kHz tone at 24k must not alias into 8k output)', () => {
    const input = sine(10000, 24000, 48000);
    const out = new Resampler(24000, 8000).process(input);
    const attenuationDb = 20 * Math.log10(rms(out, 1000) / rms(input, 1000));
    expect(attenuationDb).toBeLessThan(-50);
  });

  it('produces the expected output length ratio', () => {
    const upOut = new Resampler(8000, 16000).process(new Int16Array(8000));
    expect(Math.abs(upOut.length - 16000)).toBeLessThanOrEqual(2);
    const downOut = new Resampler(24000, 8000).process(new Int16Array(24000));
    expect(Math.abs(downOut.length - 8000)).toBeLessThanOrEqual(2);
  });

  it('is a passthrough when rates match', () => {
    const r = new Resampler(8000, 8000);
    expect(r.isPassthrough).toBe(true);
    const input = sine(440, 8000, 100);
    expect(r.process(input)).toBe(input);
  });

  it('reset() clears state so a reused instance matches a fresh one', () => {
    const input = sine(300, 8000, 500);
    const fresh = new Resampler(8000, 16000).process(input);
    const reused = new Resampler(8000, 16000);
    reused.process(sine(2000, 8000, 333));
    reused.reset();
    expect(Array.from(reused.process(input))).toEqual(Array.from(fresh));
  });
});
