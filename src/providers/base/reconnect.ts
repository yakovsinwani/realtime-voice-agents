/** Exponential backoff with optional full jitter, shared by all providers. */

export interface ReconnectPolicy {
  /** Attempts before giving up. 0 disables reconnection. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Full jitter: each delay is uniform in [0, computed]. */
  jitter: boolean;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  maxAttempts: 5,
  initialDelayMs: 250,
  maxDelayMs: 8000,
  jitter: true,
};

/** Deterministic (pre-jitter) delay for a 1-based attempt number. */
export function baseDelayForAttempt(policy: ReconnectPolicy, attempt: number): number {
  const exp = policy.initialDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, policy.maxDelayMs);
}

export function delayForAttempt(
  policy: ReconnectPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = baseDelayForAttempt(policy, attempt);
  return policy.jitter ? Math.floor(random() * base) : base;
}
