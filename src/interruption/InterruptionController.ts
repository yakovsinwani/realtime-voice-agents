/**
 * InterruptionController — decides whether a barge-in is honored.
 *
 * Gate order (first match wins): disabled → suspended (noise cooldown) →
 * tool running → guard window. The guard window protects the start of a
 * response two ways: a flat duration from playback start, and/or "first
 * sentence" (ends when sentence-final punctuation appears in the agent
 * transcript stream — generation runs ahead of playback, so this is a
 * conservative approximation; combine with guardDurationMs to tune).
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
  /** Block interruptions until the response's first sentence completes. */
  preventInterruptionOnFirstSentence?: boolean;
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

const SENTENCE_END = /[.!?။。？！…]/;

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
  private firstSentenceDone = true;
  private transcriptBuffer = '';
  private suspended = false;
  private bargeInTimestamps: number[] = [];

  constructor(settings: InterruptionSettings = {}, now: () => number = Date.now) {
    this.settings = settings;
    this.now = now;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /** A new response started generating: reset first-sentence tracking. */
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
    this.transcriptBuffer = '';
    this.firstSentenceDone = !this.settings.preventInterruptionOnFirstSentence;
  }

  /** Playback of a response reached the caller: the guard clock starts now. */
  onPlaybackStarted(responseId: string): void {
    if (responseId === this.guardResponseId) this.guardStartedAt = this.now();
  }

  /** Agent transcript delta: first sentence completes on final punctuation. */
  onAgentTranscriptDelta(responseId: string, delta: string): void {
    if (this.firstSentenceDone || responseId !== this.guardResponseId) return;
    this.transcriptBuffer += delta;
    if (SENTENCE_END.test(this.transcriptBuffer)) this.firstSentenceDone = true;
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
    const { guardDurationMs, preventInterruptionOnFirstSentence, firstResponseOnly } =
      this.settings;
    if (!guardDurationMs && !preventInterruptionOnFirstSentence) return false;
    if (firstResponseOnly && this.responseIndex > 1) return false;

    if (preventInterruptionOnFirstSentence && !this.firstSentenceDone) return true;
    if (guardDurationMs) {
      // Guard until playback has run for guardDurationMs. If playback hasn't
      // started yet, the response is at its very beginning — still guarded.
      if (this.guardStartedAt === null) return true;
      if (this.now() - this.guardStartedAt < guardDurationMs) return true;
    }
    return false;
  }
}
