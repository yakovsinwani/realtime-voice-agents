import { describe, expect, it } from 'vitest';
import { DEFAULT_RECONNECT_POLICY, baseDelayForAttempt, delayForAttempt } from './reconnect.js';

describe('reconnect policy', () => {
  it('doubles delays up to the cap', () => {
    const policy = { maxAttempts: 6, initialDelayMs: 250, maxDelayMs: 8000, jitter: false };
    const delays = [1, 2, 3, 4, 5, 6, 7].map((a) => baseDelayForAttempt(policy, a));
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 8000, 8000]);
  });

  it('without jitter returns the base delay', () => {
    expect(delayForAttempt({ ...DEFAULT_RECONNECT_POLICY, jitter: false }, 3)).toBe(1000);
  });

  it('full jitter stays within [0, base)', () => {
    const policy = DEFAULT_RECONNECT_POLICY;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const base = baseDelayForAttempt(policy, attempt);
      expect(delayForAttempt(policy, attempt, () => 0)).toBe(0);
      expect(delayForAttempt(policy, attempt, () => 0.999999)).toBeLessThan(base);
    }
  });
});
