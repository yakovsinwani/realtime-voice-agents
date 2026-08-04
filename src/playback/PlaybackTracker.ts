/**
 * PlaybackTracker — the honest playback clock.
 *
 * A mark is interleaved after every audio delta forwarded to Twilio. Twilio
 * plays media strictly in order and echoes each mark when playout reaches it,
 * so a mark echo is hardware-level confirmation of what the caller has heard —
 * unlike generation-time events, which run seconds ahead of the phone line.
 *
 * Clear-epoch: `clear` flushes Twilio's buffer, and Twilio echoes the
 * discarded marks immediately. Bumping the epoch before sending `clear` lets
 * those echoes be classified as flushed instead of played, so `playedMs`
 * stays truthful — this number feeds `conversation.item.truncate`.
 */

export const TRACKED_MARK_PREFIX = 'tra:';

interface MarkRecord {
  responseId: string;
  /** Total response audio milliseconds up to and including this chunk. */
  cumulativeMs: number;
  epoch: number;
  isFinal: boolean;
}

interface ResponseTrack {
  responseId: string;
  itemId?: string;
  totalMs: number;
  playedMs: number;
  sentMarks: number;
  echoedMarks: number;
  generationDone: boolean;
  playbackStarted: boolean;
  finished: boolean;
  flushed: boolean;
  lastEchoAtMs: number | null;
}

export interface MarkEchoResult {
  kind: 'played' | 'flushed';
  responseId: string;
  playedMs: number;
  /** First audible chunk of this response reached the caller. */
  playbackStarted: boolean;
  /** The last chunk of a completed response finished playing. */
  playbackFinished: boolean;
}

export class PlaybackTracker {
  private epoch = 0;
  private markSeq = 0;
  private readonly marks = new Map<string, MarkRecord>();
  private readonly responses = new Map<string, ResponseTrack>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Is `name` one of ours (as opposed to a host-app or background mark)? */
  static isTrackedMark(name: string): boolean {
    return name.startsWith(TRACKED_MARK_PREFIX);
  }

  /**
   * Record an outgoing audio chunk and return the mark name to interleave
   * after it.
   */
  onAudioSent(responseId: string, chunkMs: number, itemId?: string): string {
    const track = this.ensureTrack(responseId);
    if (itemId && !track.itemId) track.itemId = itemId;
    track.totalMs += chunkMs;
    track.sentMarks++;
    const name = `${TRACKED_MARK_PREFIX}${++this.markSeq}`;
    this.marks.set(name, {
      responseId,
      cumulativeMs: track.totalMs,
      epoch: this.epoch,
      isFinal: false,
    });
    return name;
  }

  /** The response finished generating; its last sent mark becomes final. */
  onGenerationDone(responseId: string): void {
    const track = this.responses.get(responseId);
    if (!track) return;
    track.generationDone = true;
    for (const record of this.marks.values()) {
      if (record.responseId === responseId && record.cumulativeMs === track.totalMs) {
        record.isFinal = true;
      }
    }
    // A response that produced no audio at all is trivially finished.
    if (track.totalMs === 0) track.finished = true;
  }

  /** Process a mark echo from Twilio. Returns null for unknown marks. */
  onMarkEcho(name: string): MarkEchoResult | null {
    const record = this.marks.get(name);
    if (!record) return null;
    this.marks.delete(name);
    const track = this.responses.get(record.responseId);
    if (!track) return null;
    track.echoedMarks++;

    if (record.epoch !== this.epoch || track.flushed) {
      this.maybeForget(track);
      return {
        kind: 'flushed',
        responseId: record.responseId,
        playedMs: track.playedMs,
        playbackStarted: false,
        playbackFinished: false,
      };
    }

    track.playedMs = Math.max(track.playedMs, record.cumulativeMs);
    track.lastEchoAtMs = this.now();
    const playbackStarted = !track.playbackStarted;
    track.playbackStarted = true;
    let playbackFinished = false;
    if (record.isFinal && track.generationDone && !track.finished) {
      track.finished = true;
      playbackFinished = true;
    }
    this.maybeForget(track);
    return {
      kind: 'played',
      responseId: record.responseId,
      playedMs: track.playedMs,
      playbackStarted,
      playbackFinished,
    };
  }

  /**
   * Bump the clear-epoch (call this immediately BEFORE sending `clear`).
   * Every un-echoed mark becomes flushed; responses with unplayed audio are
   * finalized at their current playedMs. Returns those interrupted responses.
   */
  onClear(): Array<{ responseId: string; playedMs: number; itemId?: string }> {
    this.epoch++;
    const interrupted: Array<{ responseId: string; playedMs: number; itemId?: string }> = [];
    for (const track of this.responses.values()) {
      if (!track.finished && track.playedMs < track.totalMs) {
        track.flushed = true;
        track.finished = true;
        interrupted.push({
          responseId: track.responseId,
          playedMs: track.playedMs,
          itemId: track.itemId,
        });
      }
    }
    return interrupted;
  }

  /**
   * Best-estimate of what the caller has heard of `responseId` right now:
   * last confirmed mark plus wall-clock elapsed since, clamped to the total.
   */
  estimatePlayedMs(responseId: string): number {
    const track = this.responses.get(responseId);
    if (!track) return 0;
    if (track.finished || !track.playbackStarted || track.lastEchoAtMs === null) {
      return track.playedMs;
    }
    const elapsed = this.now() - track.lastEchoAtMs;
    return Math.min(track.playedMs + Math.max(0, elapsed), track.totalMs);
  }

  /**
   * Live responses with unplayed audio, with their current played-ms
   * estimates — captured BEFORE onClear() freezes them, to feed truncation.
   */
  snapshotActive(): Array<{ responseId: string; itemId?: string; estimatedPlayedMs: number }> {
    const active: Array<{ responseId: string; itemId?: string; estimatedPlayedMs: number }> = [];
    for (const track of this.responses.values()) {
      if (!track.finished && track.totalMs > 0) {
        active.push({
          responseId: track.responseId,
          itemId: track.itemId,
          estimatedPlayedMs: this.estimatePlayedMs(track.responseId),
        });
      }
    }
    return active;
  }

  /** Any response with audio still unplayed (and not flushed)? */
  isPlaybackActive(): boolean {
    for (const track of this.responses.values()) {
      if (!track.finished && track.totalMs > 0) return true;
    }
    return false;
  }

  itemIdFor(responseId: string): string | undefined {
    return this.responses.get(responseId)?.itemId;
  }

  playedMsFor(responseId: string): number {
    return this.responses.get(responseId)?.playedMs ?? 0;
  }

  totalMsFor(responseId: string): number {
    return this.responses.get(responseId)?.totalMs ?? 0;
  }

  private ensureTrack(responseId: string): ResponseTrack {
    let track = this.responses.get(responseId);
    if (!track) {
      track = {
        responseId,
        totalMs: 0,
        playedMs: 0,
        sentMarks: 0,
        echoedMarks: 0,
        generationDone: false,
        playbackStarted: false,
        finished: false,
        flushed: false,
        lastEchoAtMs: null,
      };
      this.responses.set(responseId, track);
    }
    return track;
  }

  /** Drop bookkeeping once a response is finished and every mark came home. */
  private maybeForget(track: ResponseTrack): void {
    if (track.finished && track.echoedMarks >= track.sentMarks) {
      this.responses.delete(track.responseId);
    }
  }
}
