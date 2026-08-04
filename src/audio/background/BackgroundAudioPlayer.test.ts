import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64ByteLength } from '../mulaw.js';
import { BackgroundAudioPlayer } from './BackgroundAudioPlayer.js';

describe('BackgroundAudioPlayer', () => {
  let sent: string[];
  let player: BackgroundAudioPlayer;
  const custom = { custom: Buffer.alloc(800, 0x55) }; // 100ms loop

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    player = new BackgroundAudioPlayer({
      sendMedia: (payload) => sent.push(payload),
      now: () => Date.now(),
    });
  });

  afterEach(() => {
    player.stop({ immediate: true });
    vi.useRealTimers();
  });

  it('waits for the start delay so fast tools stay silent', () => {
    player.acquire('t1', custom, { startDelayMs: 1000 });
    vi.advanceTimersByTime(500);
    player.release('t1');
    vi.advanceTimersByTime(2000);
    expect(sent).toHaveLength(0);
  });

  it('paces ~one 20ms frame per 20ms after the delay', () => {
    player.acquire('t1', custom, { startDelayMs: 100, fadeInMs: 0 });
    vi.advanceTimersByTime(100); // delay elapses, loop starts
    vi.advanceTimersByTime(200); // 10 ticks
    expect(sent.length).toBeGreaterThanOrEqual(9);
    expect(sent.length).toBeLessThanOrEqual(12);
    for (const payload of sent) expect(base64ByteLength(payload)).toBe(160);
  });

  it('refcounts holders: audio continues until the last one releases', () => {
    player.acquire('t1', custom, { startDelayMs: 0, fadeInMs: 0 });
    player.acquire('t2', custom, { startDelayMs: 0 });
    vi.advanceTimersByTime(100);
    const afterStart = sent.length;
    expect(afterStart).toBeGreaterThan(0);
    player.release('t1');
    vi.advanceTimersByTime(60);
    expect(sent.length).toBeGreaterThan(afterStart); // t2 still holds
    player.release('t2', { immediate: true });
    const afterStop = sent.length;
    vi.advanceTimersByTime(200);
    expect(sent.length).toBe(afterStop);
  });

  it('notifyAgentAudio stops instantly with no fade frames', () => {
    player.acquire('t1', custom, { startDelayMs: 0, fadeInMs: 0, fadeOutMs: 400 });
    vi.advanceTimersByTime(80);
    const before = sent.length;
    player.notifyAgentAudio();
    vi.advanceTimersByTime(200);
    expect(sent.length).toBe(before); // no fade tail, no further frames
    expect(player.isPlaying).toBe(false);
  });

  it('graceful stop appends a fade-out tail', () => {
    player.acquire('t1', custom, { startDelayMs: 0, fadeInMs: 0, fadeOutMs: 100 });
    vi.advanceTimersByTime(60);
    const before = sent.length;
    player.stop();
    expect(sent.length).toBe(before + 5); // 100ms fade = 5 frames
  });

  it('failsafe kills a loop that runs past maxDurationMs', () => {
    player.acquire('t1', custom, { startDelayMs: 0, maxDurationMs: 300 });
    vi.advanceTimersByTime(1000);
    expect(player.isPlaying).toBe(false);
    const after = sent.length;
    vi.advanceTimersByTime(500);
    expect(sent.length).toBe(after);
  });

  it('emits started/stopped callbacks with the preset label', () => {
    const events: string[] = [];
    const labelled = new BackgroundAudioPlayer({
      sendMedia: () => {},
      onStarted: (info) => events.push(`start:${info.preset}`),
      onStopped: (info) => events.push(`stop:${info.preset}`),
    });
    labelled.start('ringing', { startDelayMs: 0 });
    labelled.stop({ immediate: true });
    expect(events).toEqual(['start:ringing', 'stop:ringing']);
  });

  it('loops seamlessly via wrap-around frames (payload size never varies)', () => {
    const tiny = { custom: Buffer.alloc(250, 0x33) }; // not a multiple of 160
    player.acquire('t1', tiny, { startDelayMs: 0, fadeInMs: 0 });
    vi.advanceTimersByTime(200);
    expect(sent.length).toBeGreaterThan(3);
    for (const payload of sent) expect(base64ByteLength(payload)).toBe(160);
  });
});
