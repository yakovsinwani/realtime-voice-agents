/**
 * Inbound noise metering: μ-law frames → dBFS levels → a sliding noise-floor
 * estimate. Pure DSP — no timers, no audio-path buffering, no base64. The
 * caller decides which frames to feed (exclusion policy lives upstream), so
 * the estimator stays reusable outside the bridge.
 */

import { MULAW_FRAME_BYTES_20MS, mulawDecodeSample } from './mulaw.js';

/** Clamp for silent/near-silent frames (all-0xFF μ-law decodes to 0). */
export const NOISE_DBFS_FLOOR = -100;

// Squared decoded values, built once — per-frame energy without a per-sample
// decode step (same pattern as the mulaw DECODE_TABLE).
const SQUARED = new Float64Array(256);
for (let i = 0; i < 256; i++) SQUARED[i] = mulawDecodeSample(i) ** 2;

/**
 * RMS level of a μ-law frame in dBFS relative to PCM16 full scale (32768).
 * μ-law's max decoded magnitude is 32124, so a full-scale μ-law tone reads
 * ≈ −0.17 dBFS instead of 0 — negligible, and the numbers stay comparable to
 * any standard PCM16 meter.
 */
export function mulawFrameDbfs(mulaw: Uint8Array): number {
  if (mulaw.length === 0) return NOISE_DBFS_FLOOR;
  let sum = 0;
  for (let i = 0; i < mulaw.length; i++) sum += SQUARED[mulaw[i]!]!;
  if (sum === 0) return NOISE_DBFS_FLOOR;
  const db = 20 * Math.log10(Math.sqrt(sum / mulaw.length) / 32768);
  return Math.min(0, Math.max(NOISE_DBFS_FLOOR, db));
}

export interface NoiseFloorEstimatorOptions {
  /** Sliding window of analyzed audio. Default 5000. */
  windowMs?: number;
  /** Percentile of per-slot RMS taken as the floor. Default 0.2. */
  percentile?: number;
}

// 1 dB buckets covering NOISE_DBFS_FLOOR..0 inclusive.
const BUCKET_COUNT = -NOISE_DBFS_FLOOR + 1;

/**
 * Sliding-window noise-floor estimator over 20 ms μ-law slots.
 *
 * The floor is a low percentile of per-slot RMS: speech bursts sit above it
 * without inflating it, and genuine quiet pauses pull it down. With the
 * default p20, `floorDb() ≥ T` means at least 80% of the window sits at or
 * above T — pervasive line noise, not a loud caller. O(1) per slot: a 1 dB
 * histogram plus a ring buffer of bucket indices.
 */
export class NoiseFloorEstimator {
  private readonly windowFrames: number;
  private readonly percentile: number;
  private readonly histogram = new Uint32Array(BUCKET_COUNT);
  private readonly ring: Uint8Array;
  private ringIndex = 0;
  private count = 0;
  /** <20 ms tail carried between addAudio calls (real Twilio frames are exactly 160 bytes). */
  private residual: Uint8Array | null = null;

  constructor(options: NoiseFloorEstimatorOptions = {}) {
    this.windowFrames = Math.max(1, Math.round((options.windowMs ?? 5000) / 20));
    this.percentile = options.percentile ?? 0.2;
    this.ring = new Uint8Array(this.windowFrames);
  }

  /** Feed raw μ-law bytes (any length; 20 ms slotting + residual carry inside). */
  addAudio(mulaw: Uint8Array): void {
    let input = mulaw;
    if (this.residual && this.residual.length > 0) {
      const merged = new Uint8Array(this.residual.length + mulaw.length);
      merged.set(this.residual, 0);
      merged.set(mulaw, this.residual.length);
      input = merged;
      this.residual = null;
    }
    let offset = 0;
    while (input.length - offset >= MULAW_FRAME_BYTES_20MS) {
      this.addSlot(input.subarray(offset, offset + MULAW_FRAME_BYTES_20MS));
      offset += MULAW_FRAME_BYTES_20MS;
    }
    if (offset < input.length) this.residual = input.slice(offset);
  }

  /** True once a full window of analyzed audio has been observed. */
  get isWarm(): boolean {
    return this.count >= this.windowFrames;
  }

  /** Noise floor over the window, dBFS in [NOISE_DBFS_FLOOR, 0]. */
  floorDb(): number {
    if (this.count === 0) return NOISE_DBFS_FLOOR;
    const rank = Math.max(1, Math.ceil(this.percentile * this.count));
    let cumulative = 0;
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      cumulative += this.histogram[bucket]!;
      if (cumulative >= rank) return bucket + NOISE_DBFS_FLOOR;
    }
    return 0;
  }

  private addSlot(slot: Uint8Array): void {
    const bucket = Math.round(mulawFrameDbfs(slot)) - NOISE_DBFS_FLOOR;
    if (this.count >= this.windowFrames) {
      const evicted = this.ring[this.ringIndex]!;
      this.histogram[evicted] = Math.max(0, this.histogram[evicted]! - 1);
    } else {
      this.count++;
    }
    this.ring[this.ringIndex] = bucket;
    this.histogram[bucket] = this.histogram[bucket]! + 1;
    this.ringIndex = (this.ringIndex + 1) % this.windowFrames;
  }
}
