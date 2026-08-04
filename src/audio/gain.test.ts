import { describe, expect, it } from 'vitest';
import { fadeMulaw, scaleMulaw } from './gain.js';
import { mulawToPcm16, pcm16ToMulaw } from './mulaw.js';

function tone(samples: number, amplitude: number): Uint8Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 8000));
  }
  return pcm16ToMulaw(pcm);
}

function rms(mulaw: Uint8Array, from: number, to: number): number {
  const pcm = mulawToPcm16(mulaw);
  let sum = 0;
  for (let i = from; i < to; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / (to - from));
}

describe('mulaw gain', () => {
  it('scaleMulaw halves amplitude in the linear domain', () => {
    const frame = tone(800, 16000);
    const scaled = scaleMulaw(frame, 0.5);
    const ratio = rms(scaled, 0, 800) / rms(frame, 0, 800);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  it('scaleMulaw with gain 1 returns the frame unchanged', () => {
    const frame = tone(160, 8000);
    expect(scaleMulaw(frame, 1)).toBe(frame);
  });

  it('fadeMulaw ramps amplitude from silent to full', () => {
    const frame = tone(1600, 16000);
    const faded = fadeMulaw(frame, 0, 1);
    const head = rms(faded, 0, 200);
    const tail = rms(faded, 1400, 1600);
    const reference = rms(frame, 1400, 1600);
    expect(head).toBeLessThan(reference * 0.2);
    expect(tail).toBeGreaterThan(reference * 0.8);
  });
});
