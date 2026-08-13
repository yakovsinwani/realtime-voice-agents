/**
 * Noise-adaptive VAD policy: watches inbound caller audio through a
 * NoiseFloorEstimator and, on sustained pervasive noise, proposes a bounded
 * turn-detection escalation (server VAD threshold up stepwise; semantic VAD
 * and sensitivity-only providers get suggestion events instead).
 *
 * Modeled on InterruptionController: pure decision objects, zero timers —
 * every clock is measured in milliseconds of inbound audio, so behavior is
 * deterministic in tests and matches wall clock on a live call.
 *
 * Lifecycle: onInboundFrame() PROPOSES without mutating ladder state — the
 * identical proposal recurs until the caller settles it:
 * - commitApplied(): the provider ACKNOWLEDGED the change (auto mode). Only
 *   this and rebase() move the effective config — an emitted-but-unapplied
 *   suggestion is never treated as reality.
 * - markSuggested(): the suggestion was surfaced (suggest mode, or a rung
 *   that is never auto-applied). Latched until rebase() so it fires once.
 * - defer(): the apply failed or timed out — retry after cooldownMs.
 * - rebase(): the app changed VAD via session.updateVad() — new effective
 *   base, fresh ladder. rebase(null) disables the controller entirely (turn
 *   detection off — noise adaptation must never re-enable it on its own).
 */

import { NoiseFloorEstimator } from '../audio/noise.js';
import type { VadConfig } from '../providers/base/BaseRealtimeProvider.js';
import type { VadTuningProfile } from '../providers/base/capabilities.js';

export interface NoiseAdaptiveVadOptions {
  /**
   * 'auto' applies each escalation via the provider's mid-session update
   * (ack-gated) and emits `vad.adjusted`; 'suggest' only emits
   * `vad.suggestion` and leaves applying to the app. Default 'auto'.
   */
  mode?: 'auto' | 'suggest';
  /** Sliding analysis window, in ms of ANALYZED (non-excluded) audio. Default 5000. */
  windowMs?: number;
  /** Noise floor (dBFS re PCM16 full scale) at/above which the line counts as noisy. Default -45. */
  noiseFloorDb?: number;
  /** How long the floor must hold, in ms of analyzed audio, before a step. Default 3000. */
  sustainMs?: number;
  /** Minimum inbound audio between steps (and between apply retries). Default 15000. */
  cooldownMs?: number;
  /** Maximum committed escalation steps per call. Default 1. */
  maxSteps?: number;
  /** Server-VAD threshold increase per step. Default 0.1. */
  thresholdStep?: number;
  /** Server-VAD threshold ceiling (intersected with the provider profile range). Default 0.9. */
  maxThreshold?: number;
}

export interface VadNoiseMetrics {
  /** Estimated noise floor at decision time, dBFS. */
  noiseFloorDb: number;
  /** The analysis window the floor was computed over. */
  windowMs: number;
  /** Analyzed audio with the floor continuously at/above the trigger. */
  sustainedMs: number;
  /** Non-excluded audio metered so far. */
  analyzedMs: number;
  /** ALL inbound audio observed (deterministic wall-clock proxy) — field data for tuning windowMs. */
  elapsedMs: number;
}

export interface VadAdjustment {
  /** Effective config before the decision (ACKed truth; `{ type: 'server' }` synthesized when unset). */
  previous: VadConfig;
  /** Recommended (suggest) or applied (auto) config. Escalation only. */
  suggested: VadConfig;
  /** 1-based step number this proposal would commit. */
  step: number;
  maxSteps: number;
  /**
   * POLICY: is this kind of change safe to apply automatically? Server-VAD
   * threshold rungs are; semantic eagerness (an end-of-turn latency control)
   * and sensitivity-only rungs are surfaced as suggestions instead. Runtime
   * gating (mode/capability) is reported separately as `willAutoApply`.
   */
  autoApplicable: boolean;
  metrics: VadNoiseMetrics;
}

interface NextRung {
  suggested: VadConfig;
  autoApplicable: boolean;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class NoiseAdaptiveVadController {
  private readonly windowMs: number;
  private readonly noiseFloorDb: number;
  private readonly sustainMs: number;
  private readonly cooldownMs: number;
  private readonly maxSteps: number;
  private readonly thresholdStep: number;
  private readonly maxThreshold: number;
  private readonly profile: VadTuningProfile | undefined;
  private readonly estimator: NoiseFloorEstimator;

  /** Current EFFECTIVE config — moved only by commitApplied()/rebase(). */
  private effective: VadConfig;
  private disabled: boolean;
  private stepsTaken = 0;
  private suggestionLatched = false;
  private sustainedMs = 0;
  /** Infinity = no step yet, so the first proposal is never cooldown-blocked. */
  private msSinceLastStep = Number.POSITIVE_INFINITY;
  private elapsedMs = 0;
  private analyzedMs = 0;
  /** Memoized next rung; `undefined` = dirty, `null` = ladder exhausted. */
  private cachedNext: NextRung | null | undefined = undefined;

  constructor(
    options: NoiseAdaptiveVadOptions,
    effectiveVad: VadConfig | null | undefined,
    profile: VadTuningProfile | undefined,
  ) {
    this.windowMs = options.windowMs ?? 5000;
    this.noiseFloorDb = options.noiseFloorDb ?? -45;
    this.sustainMs = options.sustainMs ?? 3000;
    this.cooldownMs = options.cooldownMs ?? 15_000;
    this.maxSteps = options.maxSteps ?? 1;
    this.thresholdStep = options.thresholdStep ?? 0.1;
    this.maxThreshold = options.maxThreshold ?? 0.9;
    this.profile = profile;
    this.estimator = new NoiseFloorEstimator({ windowMs: this.windowMs });
    this.disabled = effectiveVad === null;
    this.effective = effectiveVad ?? { type: 'server' };
  }

  /** No escalation room at all (disabled, or the ladder has no next rung). */
  get exhausted(): boolean {
    return this.disabled || this.nextRung() === null;
  }

  /**
   * Feed one inbound Twilio frame (base64 μ-law). `excluded` frames (user
   * speech, agent playback, pregreeting) advance the cooldown clock but are
   * kept out of the floor estimate — they freeze, not reset, the sustain
   * counter. Pure w.r.t. ladder state: the same proposal recurs until
   * commitApplied/markSuggested/defer/rebase.
   */
  onInboundFrame(base64Mulaw: string, excluded: boolean): VadAdjustment | null {
    if (this.disabled || this.suggestionLatched) return null;
    const next = this.nextRung();
    if (!next) return null;

    const bytes = Buffer.from(base64Mulaw, 'base64');
    if (bytes.length === 0) return null;
    const frameMs = bytes.length / 8;
    this.elapsedMs += frameMs;
    this.msSinceLastStep += frameMs; // Infinity stays Infinity
    if (excluded) return null;

    this.estimator.addAudio(bytes);
    this.analyzedMs += frameMs;
    if (!this.estimator.isWarm) return null;

    const floor = this.estimator.floorDb();
    if (floor >= this.noiseFloorDb) this.sustainedMs += frameMs;
    else this.sustainedMs = 0;
    if (this.sustainedMs < this.sustainMs) return null;
    if (this.msSinceLastStep < this.cooldownMs) return null;

    return {
      previous: { ...this.effective },
      suggested: next.suggested,
      step: this.stepsTaken + 1,
      maxSteps: this.maxSteps,
      autoApplicable: next.autoApplicable,
      metrics: {
        noiseFloorDb: floor,
        windowMs: this.windowMs,
        sustainedMs: this.sustainedMs,
        analyzedMs: this.analyzedMs,
        elapsedMs: this.elapsedMs,
      },
    };
  }

  /** The proposal was applied AND acknowledged: it is the new effective truth. */
  commitApplied(adjustment: VadAdjustment): void {
    this.effective = { ...adjustment.suggested };
    this.stepsTaken++;
    this.sustainedMs = 0;
    this.msSinceLastStep = 0;
    this.cachedNext = undefined;
  }

  /**
   * The suggestion was emitted without being applied: latch so it fires once
   * per effective state. The effective config is deliberately NOT moved — an
   * unapplied suggestion is not reality.
   */
  markSuggested(_adjustment: VadAdjustment): void {
    this.suggestionLatched = true;
  }

  /** The apply failed/timed out/was superseded: retry after cooldownMs. */
  defer(): void {
    this.msSinceLastStep = 0;
  }

  /**
   * App-driven updateVad(): the declared config is the new effective base —
   * a fresh ladder starts from it (never below it). `null` disables the
   * controller; a later non-null rebase re-enables it. A full cooldown
   * applies before the next adaptive step.
   */
  rebase(vad: VadConfig | null): void {
    this.disabled = vad === null;
    this.effective = vad ? { ...vad } : { type: 'server' };
    this.stepsTaken = 0;
    this.suggestionLatched = false;
    this.sustainedMs = 0;
    this.msSinceLastStep = 0;
    this.cachedNext = undefined;
  }

  private nextRung(): NextRung | null {
    if (this.cachedNext === undefined) this.cachedNext = this.computeNextRung();
    return this.cachedNext;
  }

  private computeNextRung(): NextRung | null {
    const effective = this.effective;

    if (effective.type === 'semantic') {
      // Semantic VAD's eagerness governs end-of-turn patience (low waits
      // longest), not speech-start noise sensitivity — surfaced for the app
      // to weigh against the added latency, never auto-applied.
      if (effective.eagerness === 'low') return null;
      return { suggested: { ...effective, eagerness: 'low' }, autoApplicable: false };
    }

    if (this.stepsTaken < this.maxSteps) {
      // Never invent a baseline: without an explicit configured threshold or
      // a provider-declared default, the numeric ladder stays unavailable
      // (OpenAI defaults to 0.5 but xAI to 0.85 — guessing goes backwards).
      const baseline = effective.threshold ?? this.profile?.defaultServerThreshold;
      if (baseline !== undefined) {
        const ceiling = Math.min(this.maxThreshold, this.profile?.maxServerThreshold ?? 1);
        const bottom = this.profile?.minServerThreshold ?? 0;
        const target = round2(Math.min(Math.max(baseline + this.thresholdStep, bottom), ceiling));
        if (target > baseline + 1e-9) {
          return {
            // startSensitivity rides along as the Gemini analog; wire
            // builders that don't understand it drop it (parity philosophy).
            suggested: { ...effective, type: 'server', threshold: target, startSensitivity: 'low' },
            autoApplicable: true,
          };
        }
      }
    }

    // No numeric rung (no baseline, ceiling reached, or steps exhausted):
    // a single suggestion-only sensitivity rung remains where applicable.
    if (effective.startSensitivity !== 'low') {
      return { suggested: { ...effective, startSensitivity: 'low' }, autoApplicable: false };
    }
    return null;
  }
}
