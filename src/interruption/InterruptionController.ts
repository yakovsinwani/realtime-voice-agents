/**
 * InterruptionController — decides whether a barge-in is honored.
 *
 * Gate order (first match wins): disabled → suspended (noise cooldown) →
 * tool running → guard window. The guard window protects the start of a
 * response for a flat duration measured from playback start (mark-echo
 * truth, not generation time). To make the whole first turn uninterruptible,
 * use `deafness.ignoreUserAudioUntilFirstTurnDone` instead.
 *
 * The rate limiter is the noisy-environment defense from production systems:
 * too many barge-ins inside a sliding window suspends interruptions until the
 * current playback ends, optionally injecting an instruction so the agent can
 * say "please move somewhere quieter".
 */

export interface InterruptionRateLimit {
  windowMs: number;
  /** Barge-ins inside the window that trip the limiter. */
  threshold: number;
  /** Injected once, on the rising edge, when the limiter trips. */
  instruction?: string;
}

export interface InterruptionSettings {
  /** Master switch. Default true. */
  enabled?: boolean;
  /** No-barge window measured from playback start of each response, ms. */
  guardDurationMs?: number;
  /** Apply the guard only to the first response of the call. Default false. */
  firstResponseOnly?: boolean;
  rateLimit?: InterruptionRateLimit;
}

export type InterruptionBlockCause =
  | 'disabled'
  | 'guard'
  | 'rate_limit'
  | 'tool_running'
  | 'suspended';

export type InterruptionDecision =
  | { allow: true }
  | { allow: false; cause: InterruptionBlockCause; instruction?: string };

export class InterruptionController {
  private readonly settings: InterruptionSettings;
  private readonly now: () => number;

  private responseIndex = 0;
  private guardStartedAt: number | null = null;
  private guardResponseId: string | null = null;
  /** The guarded response's audio has not finished (or been flushed) yet. */
  private guardPlaybackOpen = false;
  /** Responses that began while the guarded one was still playing. */
  private deferredStarts = 0;
  private suspended = false;
  private bargeInTimestamps: number[] = [];

  constructor(settings: InterruptionSettings = {}, now: () => number = Date.now) {
    this.settings = settings;
    this.now = now;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /** A new response started generating: rotate the guard to it. */
  onResponseStarted(responseId: string): void {
    // A response that begins while the guarded response is still audibly
    // playing (e.g. the server auto-answering a guard-blocked caller turn —
    // generation finishes long before playback) must not steal the guard:
    // the caller is still listening to the protected audio, and with
    // firstResponseOnly the index bump would disarm the guard mid-greeting
    // (field bug, Aug 2026). Rotation is deferred until playback ends.
    if (this.guardPlaybackOpen && this.guardActive()) {
      this.deferredStarts++;
      return;
    }
    this.responseIndex += 1 + this.deferredStarts;
    this.deferredStarts = 0;
    this.guardResponseId = responseId;
    this.guardStartedAt = null;
    this.guardPlaybackOpen = true;
  }

  /** Playback of a response reached the caller: the guard clock starts now. */
  onPlaybackStarted(responseId: string): void {
    if (responseId === this.guardResponseId) this.guardStartedAt = this.now();
  }

  /** Current playback finished or was cleared: cooldown suspension ends. */
  onPlaybackEnded(): void {
    this.suspended = false;
    this.guardPlaybackOpen = false;
    // Apply rotations deferred while the guarded audio was still playing.
    if (this.deferredStarts > 0) {
      this.responseIndex += this.deferredStarts;
      this.deferredStarts = 0;
    }
  }

  /**
   * Evaluate a barge-in attempt (user speech while the agent is audible).
   * Every attempt counts toward the rate limiter, including blocked ones.
   */
  evaluate(context: { toolRunning: boolean }): InterruptionDecision {
    if (this.settings.enabled === false) return { allow: false, cause: 'disabled' };
    if (this.suspended) return { allow: false, cause: 'suspended' };
    if (context.toolRunning) return { allow: false, cause: 'tool_running' };

    const rateLimit = this.settings.rateLimit;
    if (rateLimit) {
      const now = this.now();
      this.bargeInTimestamps = this.bargeInTimestamps.filter(
        (ts) => now - ts <= rateLimit.windowMs,
      );
      this.bargeInTimestamps.push(now);
      if (this.bargeInTimestamps.length >= rateLimit.threshold) {
        this.suspended = true;
        this.bargeInTimestamps = [];
        return { allow: false, cause: 'rate_limit', instruction: rateLimit.instruction };
      }
    }

    if (this.guardActive()) return { allow: false, cause: 'guard' };
    return { allow: true };
  }

  private guardActive(): boolean {
    const { guardDurationMs, firstResponseOnly } = this.settings;
    if (!guardDurationMs) return false;
    if (firstResponseOnly && this.responseIndex > 1) return false;

    // Guard until playback has run for guardDurationMs. If playback hasn't
    // started yet, the response is at its very beginning — still guarded.
    if (this.guardStartedAt === null) return true;
    return this.now() - this.guardStartedAt < guardDurationMs;
  }
}
