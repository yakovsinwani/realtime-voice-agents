import { describe, expect, it } from 'vitest';
import { MULAW_SILENCE_BYTE } from './mulaw.js';
import { pcm16ToMulaw } from './mulaw.js';
import { NOISE_DBFS_FLOOR, NoiseFloorEstimator, mulawFrameDbfs } from './noise.js';

/** 440 Hz μ-law tone. RMS dBFS of amplitude A ≈ 20·log10(A / √2 / 32768). */
function tone(samples: number, amplitude: number): Uint8Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 8000));
  }
  return pcm16ToMulaw(pcm);
}

function silenceSlot(): Uint8Array {
  return new Uint8Array(160).fill(MULAW_SILENCE_BYTE);
}

// Reference amplitudes: RMS dBFS = 20·log10(A/√2/32768)
const AMP_FULL_SCALE = 32124; // ≈ −3.2 dBFS (μ-law max magnitude)
const AMP_MINUS_15 = 8241;
const AMP_MINUS_30 = 1465;
const AMP_MINUS_50 = 147;

describe('mulawFrameDbfs', () => {
  it('reads μ-law silence as the clamp floor', () => {
    expect(mulawFrameDbfs(silenceSlot())).toBe(NOISE_DBFS_FLOOR);
    expect(mulawFrameDbfs(new Uint8Array(0))).toBe(NOISE_DBFS_FLOOR);
  });

  it('reads a full-scale tone near 0 dBFS (−3.2 for a sine at μ-law max)', () => {
    const db = mulawFrameDbfs(tone(160, AMP_FULL_SCALE));
    expect(db).toBeGreaterThan(-3.7);
    expect(db).toBeLessThan(-2.7);
  });

  it('tracks level down the scale within μ-law quantization error', () => {
    const at30 = mulawFrameDbfs(tone(160, AMP_MINUS_30));
    expect(at30).toBeGreaterThan(-31.5);
    expect(at30).toBeLessThan(-28.5);
    const at50 = mulawFrameDbfs(tone(160, AMP_MINUS_50));
    expect(at50).toBeGreaterThan(-52);
    expect(at50).toBeLessThan(-48);
  });
});

describe('NoiseFloorEstimator', () => {
  it('is warm exactly when a full window of analyzed audio has been seen', () => {
    const estimator = new NoiseFloorEstimator({ windowMs: 200 }); // 10 slots
    for (let i = 0; i < 9; i++) estimator.addAudio(tone(160, AMP_MINUS_30));
    expect(estimator.isWarm).toBe(false);
    estimator.addAudio(tone(160, AMP_MINUS_30));
    expect(estimator.isWarm).toBe(true);
  });

  it('tracks a steady tone as the floor', () => {
    const estimator = new NoiseFloorEstimator({ windowMs: 200 });
    for (let i = 0; i < 20; i++) estimator.addAudio(tone(160, AMP_MINUS_30));
    expect(estimator.floorDb()).toBeGreaterThan(-32);
    expect(estimator.floorDb()).toBeLessThan(-28);
  });

  it('ignores interleaved loud speech-like bursts (floor = the quiet 80%)', () => {
    const estimator = new NoiseFloorEstimator({ windowMs: 400 }); // 20 slots
    for (let group = 0; group < 5; group++) {
      for (let i = 0; i < 4; i++) estimator.addAudio(tone(160, AMP_MINUS_50));
      estimator.addAudio(tone(160, AMP_MINUS_15)); // "speech" burst
    }
    expect(estimator.floorDb()).toBeGreaterThan(-52);
    expect(estimator.floorDb()).toBeLessThan(-47);
  });

  it('lets genuine silence win the percentile (talking in a quiet room ≠ noise)', () => {
    const estimator = new NoiseFloorEstimator({ windowMs: 400 }); // 20 slots, p20 rank = 4
    for (let group = 0; group < 2; group++) {
      for (let i = 0; i < 3; i++) estimator.addAudio(silenceSlot());
      for (let i = 0; i < 7; i++) estimator.addAudio(tone(160, AMP_MINUS_30));
    }
    expect(estimator.floorDb()).toBe(NOISE_DBFS_FLOOR);
  });

  it('carries residual bytes across addAudio calls (non-160-byte chunks)', () => {
    const estimator = new NoiseFloorEstimator({ windowMs: 200 }); // 10 slots
    const audio = tone(1600, AMP_MINUS_30); // exactly 10 slots worth
    for (let offset = 0; offset < audio.length; offset += 100) {
      estimator.addAudio(audio.subarray(offset, offset + 100));
    }
    expect(estimator.isWarm).toBe(true);
    expect(estimator.floorDb()).toBeGreaterThan(-32);
    expect(estimator.floorDb()).toBeLessThan(-28);
  });

  it('evicts old slots as the window slides', () => {
    const estimator = new NoiseFloorEstimator({ windowMs: 200 }); // 10 slots
    for (let i = 0; i < 10; i++) estimator.addAudio(silenceSlot());
    expect(estimator.floorDb()).toBe(NOISE_DBFS_FLOOR);
    // A full window of tone replaces every silent slot.
    for (let i = 0; i < 10; i++) estimator.addAudio(tone(160, AMP_MINUS_30));
    expect(estimator.floorDb()).toBeGreaterThan(-32);
    expect(estimator.floorDb()).toBeLessThan(-28);
  });
});
