import { describe, expect, it } from 'vitest';
import { InterruptionController } from './InterruptionController.js';

const noTool = { toolRunning: false };

describe('InterruptionController', () => {
  it('allows barge-in by default', () => {
    const c = new InterruptionController();
    c.onResponseStarted('r1');
    c.onPlaybackStarted('r1');
    expect(c.evaluate(noTool)).toEqual({ allow: true });
  });

  it('blocks everything when disabled', () => {
    const c = new InterruptionController({ enabled: false });
    expect(c.evaluate(noTool)).toEqual({ allow: false, cause: 'disabled' });
  });

  it('blocks while a tool is running', () => {
    const c = new InterruptionController();
    expect(c.evaluate({ toolRunning: true })).toEqual({ allow: false, cause: 'tool_running' });
  });

  it('guard window blocks from playback start until the duration elapses', () => {
    let now = 0;
    const c = new InterruptionController({ guardDurationMs: 1500 }, () => now);
    c.onResponseStarted('r1');
    // Playback not started yet: the response is at its very start — guarded.
    expect(c.evaluate(noTool)).toEqual({ allow: false, cause: 'guard' });
    c.onPlaybackStarted('r1');
    now = 1000;
    expect(c.evaluate(noTool)).toEqual({ allow: false, cause: 'guard' });
    now = 1600;
    expect(c.evaluate(noTool)).toEqual({ allow: true });
  });

  it('firstResponseOnly applies the guard just once', () => {
    const now = 0;
    const c = new InterruptionController({ guardDurationMs: 1000, firstResponseOnly: true }, () => now);
    c.onResponseStarted('r1');
    c.onPlaybackStarted('r1');
    expect(c.evaluate(noTool).allow).toBe(false);
    c.onPlaybackEnded(); // r1 finished playing — the normal turn boundary
    c.onResponseStarted('r2');
    c.onPlaybackStarted('r2');
    expect(c.evaluate(noTool).allow).toBe(true);
  });

  it('rate limiter trips on the rising edge, suspends, and recovers at playback end', () => {
    let now = 0;
    const c = new InterruptionController(
      { rateLimit: { windowMs: 10_000, threshold: 3, instruction: 'Too noisy, please move.' } },
      () => now,
    );
    c.onResponseStarted('r1');
    c.onPlaybackStarted('r1');
    expect(c.evaluate(noTool).allow).toBe(true);
    now += 100;
    expect(c.evaluate(noTool).allow).toBe(true);
    now += 100;
    const tripped = c.evaluate(noTool);
    expect(tripped).toEqual({ allow: false, cause: 'rate_limit', instruction: 'Too noisy, please move.' });
    expect(c.isSuspended).toBe(true);
    // While suspended everything is blocked without re-tripping.
    expect(c.evaluate(noTool)).toEqual({ allow: false, cause: 'suspended' });
    c.onPlaybackEnded();
    expect(c.isSuspended).toBe(false);
    expect(c.evaluate(noTool).allow).toBe(true);
  });

  it('old barge-ins age out of the rate-limit window', () => {
    let now = 0;
    const c = new InterruptionController(
      { rateLimit: { windowMs: 1000, threshold: 3 } },
      () => now,
    );
    expect(c.evaluate(noTool).allow).toBe(true);
    now += 600;
    expect(c.evaluate(noTool).allow).toBe(true);
    now += 600; // first one is now outside the window
    expect(c.evaluate(noTool).allow).toBe(true);
  });

  it('a response starting while the guarded one still plays does not steal the guard', () => {
    let now = 0;
    const c = new InterruptionController(
      { guardDurationMs: 60_000, firstResponseOnly: true },
      () => now,
    );
    c.onResponseStarted('r1');
    c.onPlaybackStarted('r1');
    now += 500;
    expect(c.evaluate(noTool)).toEqual({ allow: false, cause: 'guard' });

    // The server auto-answers a blocked turn mid-playback (its generation of
    // r1 finished long before the caller heard it all).
    c.onResponseStarted('phantom');
    now += 500;
    expect(c.evaluate(noTool)).toEqual({ allow: false, cause: 'guard' }); // still guarded

    // Guarded playback ends: the deferred rotation applies, firstResponseOnly
    // is spent, and later responses are freely interruptible.
    c.onPlaybackEnded();
    c.onResponseStarted('r3');
    c.onPlaybackStarted('r3');
    expect(c.evaluate(noTool).allow).toBe(true);
  });

  it('a guarded response that produces no audio releases the hold on settle', () => {
    const c = new InterruptionController({ guardDurationMs: 60_000 }, () => 0);
    c.onResponseStarted('r1');
    c.onPlaybackEnded(); // CallSession settles a no-audio response this way
    c.onResponseStarted('r2');
    c.onPlaybackStarted('r2');
    // r2 owns the guard — rotation was not left stuck on the silent r1.
    expect(c.evaluate(noTool)).toEqual({ allow: false, cause: 'guard' });
  });
});
