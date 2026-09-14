import { describe, expect, it } from 'vitest';
import { PlaybackTracker } from './PlaybackTracker.js';

// checkpointIntervalMs: 1 forces a mark on every chunk — handy where the
// scenario needs per-chunk granularity (epoch/flush classification).
const perChunk = { checkpointIntervalMs: 1 };

describe('PlaybackTracker', () => {
  it('emits a mark on the first chunk, then only at checkpoint intervals', () => {
    const t = new PlaybackTracker(() => 0, { checkpointIntervalMs: 200 });
    const m1 = t.onAudioSent('r1', 100, 'item1');
    expect(m1).not.toBeNull(); // first chunk always marks
    expect(t.onAudioSent('r1', 150)).toBeNull(); // 150ms since mark < 200
    const m2 = t.onAudioSent('r1', 100); // 250ms since mark ≥ 200
    expect(m2).not.toBeNull();
    expect(t.totalMsFor('r1')).toBe(350);
  });

  it('tracks cumulative playedMs through checkpoint echoes and detects start/finish', () => {
    let now = 1000;
    const t = new PlaybackTracker(() => now, { checkpointIntervalMs: 200 });
    const m1 = t.onAudioSent('r1', 100, 'item1')!;
    t.onAudioSent('r1', 150); // no mark
    const tail = t.onGenerationDone('r1');
    expect(tail).not.toBeNull(); // 150ms accumulated past the last checkpoint

    const e1 = t.onMarkEcho(m1)!;
    expect(e1).toMatchObject({ kind: 'played', playedMs: 100, playbackStarted: true, playbackFinished: false });

    now += 50;
    expect(t.estimatePlayedMs('r1')).toBe(150); // 100 confirmed + 50 wall-clock

    const e2 = t.onMarkEcho(tail!)!;
    expect(e2).toMatchObject({ kind: 'played', playedMs: 250, playbackFinished: true });
    expect(t.isPlaybackActive()).toBe(false);
  });

  it('flags a pending mark that covers the full total as final instead of adding a tail', () => {
    const t = new PlaybackTracker(() => 0, { checkpointIntervalMs: 200 });
    const m1 = t.onAudioSent('r1', 100)!;
    const m2 = t.onAudioSent('r1', 200)!; // checkpoint at exactly totalMs=300
    expect(t.onGenerationDone('r1')).toBeNull(); // m2 covers 300 — no tail mark
    t.onMarkEcho(m1);
    const echo = t.onMarkEcho(m2)!;
    expect(echo).toMatchObject({ kind: 'played', playedMs: 300, playbackFinished: true });
  });

  it('finishes without a tail when the covering mark echoed before generation done', () => {
    const t = new PlaybackTracker(() => 0, { checkpointIntervalMs: 1 });
    const m1 = t.onAudioSent('r1', 100)!;
    t.onMarkEcho(m1); // full total already confirmed played
    expect(t.onGenerationDone('r1')).toBeNull();
    expect(t.isPlaybackActive()).toBe(false);
    expect(t.totalMsFor('r1')).toBe(0); // track dropped, no leak
  });

  it('estimate is clamped to total audio', () => {
    let now = 0;
    const t = new PlaybackTracker(() => now, perChunk);
    const m1 = t.onAudioSent('r1', 100)!;
    t.onAudioSent('r1', 20);
    t.onMarkEcho(m1);
    now += 5000;
    expect(t.estimatePlayedMs('r1')).toBe(120);
  });

  it('classifies pre-clear marks as flushed and freezes playedMs', () => {
    const t = new PlaybackTracker(() => 0, perChunk);
    const m1 = t.onAudioSent('r1', 100, 'item1')!;
    const m2 = t.onAudioSent('r1', 100)!;
    const m3 = t.onAudioSent('r1', 100)!;
    t.onMarkEcho(m1);

    const interrupted = t.onClear();
    expect(interrupted).toEqual([{ responseId: 'r1', playedMs: 100, itemId: 'item1' }]);

    // Twilio echoes the discarded marks; they must not advance playedMs.
    expect(t.onMarkEcho(m2)!.kind).toBe('flushed');
    expect(t.onMarkEcho(m3)!.kind).toBe('flushed');
    expect(t.isPlaybackActive()).toBe(false);
  });

  it('generation done after a clear produces no zombie tail mark', () => {
    const t = new PlaybackTracker(() => 0, { checkpointIntervalMs: 200 });
    t.onAudioSent('r1', 100);
    t.onAudioSent('r1', 50); // unmarked tail exists
    t.onClear();
    expect(t.onGenerationDone('r1')).toBeNull();
  });

  it('marks sent after a clear belong to the new epoch and play normally', () => {
    const t = new PlaybackTracker(() => 0, perChunk);
    const old = t.onAudioSent('r1', 100)!;
    t.onClear();
    const fresh = t.onAudioSent('r2', 80, 'item2')!;
    expect(t.onGenerationDone('r2')).toBeNull(); // fresh covers the full total
    expect(t.onMarkEcho(old)!.kind).toBe('flushed');
    const echo = t.onMarkEcho(fresh)!;
    expect(echo).toMatchObject({ kind: 'played', responseId: 'r2', playedMs: 80, playbackFinished: true });
  });

  it('snapshotActive reports live estimates before a clear freezes them', () => {
    let now = 0;
    const t = new PlaybackTracker(() => now, perChunk);
    const m1 = t.onAudioSent('r1', 200, 'itemX')!;
    t.onAudioSent('r1', 200);
    t.onMarkEcho(m1);
    now += 70;
    const active = t.snapshotActive();
    expect(active).toEqual([{ responseId: 'r1', itemId: 'itemX', estimatedPlayedMs: 270 }]);
  });

  it('a response with no audio finishes trivially at generation done', () => {
    const t = new PlaybackTracker(() => 0);
    t.onAudioSent('r1', 50);
    expect(t.onGenerationDone('r2')).toBeNull(); // unknown response — no crash
    expect(t.isPlaybackActive()).toBe(true);
  });

  it('forgets responses once finished and all marks echoed (no leak)', () => {
    const t = new PlaybackTracker(() => 0, perChunk);
    const m1 = t.onAudioSent('r1', 100)!;
    expect(t.onGenerationDone('r1')).toBeNull();
    t.onMarkEcho(m1);
    expect(t.totalMsFor('r1')).toBe(0); // track dropped
  });

  it('ignores unknown mark names', () => {
    const t = new PlaybackTracker(() => 0);
    expect(t.onMarkEcho('tra:999')).toBeNull();
    expect(t.onMarkEcho('bg:1')).toBeNull();
  });

  it('abandonOpen finalizes responses whose session is gone, so a lost tail mark cannot keep playback active', () => {
    const t = new PlaybackTracker(() => 0, { checkpointIntervalMs: 200 });
    const m1 = t.onAudioSent('cut', 100)!;
    t.onAudioSent('cut', 150); // generation never completes: the session closed under it
    const m2 = t.onAudioSent('done', 100)!;
    t.onGenerationDone('done');
    t.onMarkEcho(m2); // already finished honestly — not touched
    expect(t.isPlaybackActive()).toBe(true);

    const abandoned = t.abandonOpen();
    expect(abandoned).toEqual([{ responseId: 'cut', playedMs: 0, itemId: undefined }]);
    expect(t.isPlaybackActive()).toBe(false);
    // A late echo for the abandoned response is flushed, not played.
    expect(t.onMarkEcho(m1)).toMatchObject({ kind: 'flushed', responseId: 'cut', playbackFinished: false });
    expect(t.abandonOpen()).toEqual([]); // idempotent
  });
});
