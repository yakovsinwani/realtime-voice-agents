import { describe, expect, it } from 'vitest';
import { MULAW_SILENCE_BYTE, pcm16ToMulaw } from '../audio/mulaw.js';
import type { VadTuningProfile } from '../providers/base/capabilities.js';
import { NoiseAdaptiveVadController, type VadAdjustment } from './NoiseAdaptiveVadController.js';

/** One 20 ms base64 μ-law frame of a 440 Hz tone. */
function toneFrame(amplitude: number): string {
  const pcm = new Int16Array(160);
  for (let i = 0; i < 160; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 8000));
  }
  return Buffer.from(pcm16ToMulaw(pcm)).toString('base64');
}

const NOISE = toneFrame(1465); // ≈ −30 dBFS, above the −45 trigger
const SILENCE = Buffer.alloc(160, MULAW_SILENCE_BYTE).toString('base64');

// Fast, deterministic clocks (all in ms of audio; frames are 20 ms each):
// warm after 5 frames, sustain after 3 more, cooldown = 10 frames.
const OPTS = { windowMs: 100, sustainMs: 60, cooldownMs: 200, maxSteps: 2 };

const OPENAI_PROFILE: VadTuningProfile = {
  defaultServerThreshold: 0.5,
  minServerThreshold: 0,
  maxServerThreshold: 1,
};
const XAI_PROFILE: VadTuningProfile = {
  defaultServerThreshold: 0.85,
  minServerThreshold: 0.1,
  maxServerThreshold: 0.9,
};

function feedUntil(
  controller: NoiseAdaptiveVadController,
  frame: string,
  maxFrames: number,
  excluded = false,
): VadAdjustment | null {
  for (let i = 0; i < maxFrames; i++) {
    const proposal = controller.onInboundFrame(frame, excluded);
    if (proposal) return proposal;
  }
  return null;
}

describe('NoiseAdaptiveVadController ladder', () => {
  it('escalates the threshold stepwise from the effective base and stops at maxSteps', () => {
    const c = new NoiseAdaptiveVadController(OPTS, { type: 'server', threshold: 0.5 }, OPENAI_PROFILE);
    const p1 = feedUntil(c, NOISE, 20);
    expect(p1).not.toBeNull();
    expect(p1!.suggested.threshold).toBe(0.6);
    expect(p1!.autoApplicable).toBe(true);
    expect(p1!.step).toBe(1);
    expect(p1!.previous).toEqual({ type: 'server', threshold: 0.5 });
    c.commitApplied(p1!);

    const p2 = feedUntil(c, NOISE, 20);
    expect(p2!.suggested.threshold).toBe(0.7);
    expect(p2!.step).toBe(2);
    c.commitApplied(p2!);

    expect(feedUntil(c, NOISE, 50)).toBeNull(); // maxSteps reached
    expect(c.exhausted).toBe(true);
  });

  it('xAI profile: single rung 0.85 → 0.9, then exhausted (never invents 0.5)', () => {
    const c = new NoiseAdaptiveVadController(OPTS, { type: 'server' }, XAI_PROFILE);
    const p = feedUntil(c, NOISE, 20);
    expect(p!.suggested.threshold).toBe(0.9);
    c.commitApplied(p!);
    expect(feedUntil(c, NOISE, 50)).toBeNull();
    expect(c.exhausted).toBe(true);
  });

  it('an explicit effective threshold beats the profile default (0.7 → 0.8, never 0.6)', () => {
    const c = new NoiseAdaptiveVadController(OPTS, { type: 'server', threshold: 0.7 }, OPENAI_PROFILE);
    const p = feedUntil(c, NOISE, 20);
    expect(p!.suggested.threshold).toBe(0.8);
  });

  it('no configured threshold + no profile ⇒ sensitivity-rider suggestion only', () => {
    const c = new NoiseAdaptiveVadController(OPTS, { type: 'server' }, undefined);
    const p = feedUntil(c, NOISE, 20);
    expect(p!.suggested.threshold).toBeUndefined();
    expect(p!.suggested.startSensitivity).toBe('low');
    expect(p!.autoApplicable).toBe(false);
  });

  it('semantic VAD: single eagerness-low rung, never auto-applicable; already-low is born exhausted', () => {
    const c = new NoiseAdaptiveVadController(
      OPTS,
      { type: 'semantic', eagerness: 'medium', createResponse: false },
      OPENAI_PROFILE,
    );
    const p = feedUntil(c, NOISE, 20);
    expect(p!.suggested).toEqual({ type: 'semantic', eagerness: 'low', createResponse: false });
    expect(p!.autoApplicable).toBe(false);

    const low = new NoiseAdaptiveVadController(OPTS, { type: 'semantic', eagerness: 'low' }, undefined);
    expect(low.exhausted).toBe(true);
    expect(feedUntil(low, NOISE, 30)).toBeNull();
  });

  it('a null effective vad (turn detection off) disables the controller', () => {
    const c = new NoiseAdaptiveVadController(OPTS, null, OPENAI_PROFILE);
    expect(c.exhausted).toBe(true);
    expect(feedUntil(c, NOISE, 30)).toBeNull();
  });

  it('preserves explicit effective fields in the suggestion', () => {
    const c = new NoiseAdaptiveVadController(
      OPTS,
      { type: 'server', threshold: 0.5, silenceDurationMs: 700, interruptResponse: false },
      OPENAI_PROFILE,
    );
    const p = feedUntil(c, NOISE, 20);
    expect(p!.suggested).toEqual({
      type: 'server',
      threshold: 0.6,
      silenceDurationMs: 700,
      interruptResponse: false,
      startSensitivity: 'low',
    });
  });
});

describe('NoiseAdaptiveVadController timing (ms of audio, no timers)', () => {
  const make = () =>
    new NoiseAdaptiveVadController(OPTS, { type: 'server', threshold: 0.5 }, OPENAI_PROFILE);

  it('does not decide before a full window has been analyzed', () => {
    const c = make();
    for (let i = 0; i < 4; i++) expect(c.onInboundFrame(NOISE, false)).toBeNull();
  });

  it('fires exactly when the sustain requirement is met', () => {
    const c = make();
    for (let i = 0; i < 6; i++) expect(c.onInboundFrame(NOISE, false)).toBeNull(); // warm@5, sustained 40
    expect(c.onInboundFrame(NOISE, false)).not.toBeNull(); // sustained 60
  });

  it('a quiet gap resets the sustain counter', () => {
    const c = make();
    for (let i = 0; i < 6; i++) c.onInboundFrame(NOISE, false); // sustained 40
    for (let i = 0; i < 2; i++) expect(c.onInboundFrame(SILENCE, false)).toBeNull(); // floor drops, reset
    // Fresh run required: the silence slots must first leave the window
    // (floor stays low until the 5th post-gap frame), then sustain rebuilds
    // from zero — carried-over sustain would fire by the 5th frame here.
    for (let i = 0; i < 6; i++) expect(c.onInboundFrame(NOISE, false)).toBeNull();
    expect(c.onInboundFrame(NOISE, false)).not.toBeNull();
  });

  it('excluded frames freeze (not reset) the sustain and stay out of the floor', () => {
    const c = make();
    for (let i = 0; i < 6; i++) c.onInboundFrame(NOISE, false); // sustained 40
    // Excluded SILENCE would reset the run if it reached the estimator.
    for (let i = 0; i < 10; i++) expect(c.onInboundFrame(SILENCE, true)).toBeNull();
    const p = c.onInboundFrame(NOISE, false); // sustained 60 — run survived
    expect(p).not.toBeNull();
    expect(p!.metrics.analyzedMs).toBeLessThan(p!.metrics.elapsedMs);
    expect(p!.metrics.noiseFloorDb).toBeGreaterThan(-32);
    expect(p!.metrics.noiseFloorDb).toBeLessThan(-28);
  });

  it('enforces the cooldown between steps', () => {
    const c = make();
    const p1 = feedUntil(c, NOISE, 20);
    c.commitApplied(p1!);
    for (let i = 0; i < 9; i++) expect(c.onInboundFrame(NOISE, false)).toBeNull();
    expect(c.onInboundFrame(NOISE, false)).not.toBeNull(); // 10th frame = 200 ms
  });

  it('repeats the identical proposal until it is settled', () => {
    const c = make();
    const p1 = feedUntil(c, NOISE, 20);
    const p2 = c.onInboundFrame(NOISE, false);
    expect(p2!.suggested).toEqual(p1!.suggested);
    expect(p2!.step).toBe(p1!.step);
  });

  it('defer() delays the retry by a full cooldown', () => {
    const c = make();
    const p1 = feedUntil(c, NOISE, 20);
    c.defer();
    for (let i = 0; i < 9; i++) expect(c.onInboundFrame(NOISE, false)).toBeNull();
    const retry = c.onInboundFrame(NOISE, false);
    expect(retry!.suggested).toEqual(p1!.suggested); // same step — nothing was committed
  });
});

describe('NoiseAdaptiveVadController state transitions', () => {
  const make = () =>
    new NoiseAdaptiveVadController(OPTS, { type: 'server', threshold: 0.5 }, OPENAI_PROFILE);

  it('markSuggested latches until rebase; applying the suggestion continues the ladder', () => {
    const c = make();
    const p = feedUntil(c, NOISE, 20);
    c.markSuggested(p!);
    expect(feedUntil(c, NOISE, 40)).toBeNull(); // latched — one suggestion per effective state
    expect(c.exhausted).toBe(false); // dormant, not exhausted

    c.rebase(p!.suggested); // the app applied it via updateVad()
    const next = feedUntil(c, NOISE, 40);
    expect(next!.suggested.threshold).toBe(0.7);
  });

  it('rebase to a manual override escalates relative to it (0.8 → 0.9, never 0.6)', () => {
    const c = make();
    feedUntil(c, NOISE, 20); // an unsettled 0.6 proposal exists
    c.rebase({ type: 'server', threshold: 0.8 });
    const p = feedUntil(c, NOISE, 40);
    expect(p!.suggested.threshold).toBe(0.9);
    expect(p!.previous.threshold).toBe(0.8);
  });

  it('rebase(null) disables adaptation; a later non-null rebase re-enables it', () => {
    const c = make();
    c.rebase(null);
    expect(c.exhausted).toBe(true);
    expect(feedUntil(c, NOISE, 40)).toBeNull();

    c.rebase({ type: 'server', threshold: 0.5 });
    const p = feedUntil(c, NOISE, 40);
    expect(p!.suggested.threshold).toBe(0.6);
  });
});
