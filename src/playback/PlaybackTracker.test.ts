import { describe, expect, it } from 'vitest';
import { PlaybackTracker } from './PlaybackTracker.js';

describe('PlaybackTracker', () => {
  it('tracks cumulative playedMs through mark echoes and detects start/finish', () => {
    let now = 1000;
    const t = new PlaybackTracker(() => now);
    const m1 = t.onAudioSent('r1', 100, 'item1');
    const m2 = t.onAudioSent('r1', 150);
    t.onGenerationDone('r1');

    const e1 = t.onMarkEcho(m1)!;
    expect(e1).toMatchObject({ kind: 'played', playedMs: 100, playbackStarted: true, playbackFinished: false });

    now += 50;
    expect(t.estimatePlayedMs('r1')).toBe(150); // 100 played + 50 elapsed

    const e2 = t.onMarkEcho(m2)!;
    expect(e2).toMatchObject({ kind: 'played', playedMs: 250, playbackFinished: true });
    expect(t.isPlaybackActive()).toBe(false);
  });

  it('estimate is clamped to total audio', () => {
    let now = 0;
    const t = new PlaybackTracker(() => now);
    const m1 = t.onAudioSent('r1', 100);
    t.onAudioSent('r1', 20);
    t.onMarkEcho(m1);
    now += 5000;
    expect(t.estimatePlayedMs('r1')).toBe(120);
  });

  it('classifies pre-clear marks as flushed and freezes playedMs', () => {
    const t = new PlaybackTracker(() => 0);
    const m1 = t.onAudioSent('r1', 100, 'item1');
    const m2 = t.onAudioSent('r1', 100);
    const m3 = t.onAudioSent('r1', 100);
    t.onMarkEcho(m1);

    const interrupted = t.onClear();
    expect(interrupted).toEqual([{ responseId: 'r1', playedMs: 100, itemId: 'item1' }]);

    // Twilio echoes the discarded marks; they must not advance playedMs.
    expect(t.onMarkEcho(m2)!.kind).toBe('flushed');
    expect(t.onMarkEcho(m3)!.kind).toBe('flushed');
    expect(t.isPlaybackActive()).toBe(false);
  });

  it('marks sent after a clear belong to the new epoch and play normally', () => {
    const t = new PlaybackTracker(() => 0);
    const old = t.onAudioSent('r1', 100);
    t.onClear();
    const fresh = t.onAudioSent('r2', 80, 'item2');
    t.onGenerationDone('r2');
    expect(t.onMarkEcho(old)!.kind).toBe('flushed');
    const echo = t.onMarkEcho(fresh)!;
    expect(echo).toMatchObject({ kind: 'played', responseId: 'r2', playedMs: 80, playbackFinished: true });
  });

  it('snapshotActive reports live estimates before a clear freezes them', () => {
    let now = 0;
    const t = new PlaybackTracker(() => now);
    const m1 = t.onAudioSent('r1', 200, 'itemX');
    t.onAudioSent('r1', 200);
    t.onMarkEcho(m1);
    now += 70;
    const active = t.snapshotActive();
    expect(active).toEqual([{ responseId: 'r1', itemId: 'itemX', estimatedPlayedMs: 270 }]);
  });

  it('a response with no audio finishes trivially at generation done', () => {
    const t = new PlaybackTracker(() => 0);
    t.onAudioSent('r1', 50);
    t.onGenerationDone('r2'); // unknown response — no crash, no effect
    expect(t.isPlaybackActive()).toBe(true);
  });

  it('forgets responses once finished and all marks echoed (no leak)', () => {
    const t = new PlaybackTracker(() => 0);
    const m1 = t.onAudioSent('r1', 100);
    t.onGenerationDone('r1');
    t.onMarkEcho(m1);
    expect(t.totalMsFor('r1')).toBe(0); // track dropped
  });

  it('ignores unknown mark names', () => {
    const t = new PlaybackTracker(() => 0);
    expect(t.onMarkEcho('tra:999')).toBeNull();
    expect(t.onMarkEcho('bg:1')).toBeNull();
  });
});
