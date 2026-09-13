/**
 * Groups GPT-Live transcript fragments into turns.
 *
 * Fragments arrive on ~200 ms frame boundaries with session-timeline
 * `start_ms` / `end_ms` and no turn marker ("a fragment isn't a complete
 * turn"). A gap of `gapMs` on that timeline — or `idleMs` of wall-clock with
 * no new fragment — ends the turn. 0.8 s is what LiveKit and Pipecat settled
 * on; the wall-clock idle only covers the tail of a conversation, where no
 * later fragment ever arrives to reveal the gap.
 */

export interface TranscriptTurn {
  text: string;
  startMs: number;
  endMs: number;
  /** Whatever `tagFor()` returned when the turn opened (an utterance id). */
  tag?: string;
}

export interface TranscriptGrouperOptions {
  gapMs: number;
  idleMs: number;
  onTurn: (turn: TranscriptTurn) => void;
  tagFor?: () => string | undefined;
}

export class TranscriptGrouper {
  private current: TranscriptTurn | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: TranscriptGrouperOptions) {}

  push(delta: string, startMs: number, endMs: number): void {
    if (this.current && startMs - this.current.endMs > this.options.gapMs) this.flush();
    if (!this.current) {
      this.current = { text: '', startMs, endMs, tag: this.options.tagFor?.() };
    }
    this.current.text += delta;
    this.current.endMs = Math.max(this.current.endMs, endMs);
    this.armIdle();
  }

  /** Close the open turn now (session ending, utterance boundary reached). */
  flush(): void {
    this.clearIdle();
    const turn = this.current;
    this.current = null;
    if (!turn) return;
    const text = turn.text.trim();
    if (text.length === 0) return;
    this.options.onTurn({ ...turn, text });
  }

  dispose(): void {
    this.clearIdle();
    this.current = null;
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.flush();
    }, this.options.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
