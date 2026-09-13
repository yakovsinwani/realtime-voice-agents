import { describe, expect, it, vi } from 'vitest';
import { pcm16ToMulaw, MULAW_SILENCE_BYTE } from '../../audio/mulaw.js';
import { SpeechGate, isDigitalSilence } from './speech-gate.js';
import { TranscriptGrouper } from './transcript-grouper.js';

function tone(ms: number, amplitude = 3200): Uint8Array {
  const pcm = new Int16Array(ms * 8);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 8000));
  return pcm16ToMulaw(pcm);
}
const silence = (ms: number) => new Uint8Array(ms * 8).fill(MULAW_SILENCE_BYTE);

describe('SpeechGate (utterance boundaries from the continuous stream)', () => {
  it('stays closed on digital silence and near-silence, opens on speech, closes after 800 ms of quiet audio', () => {
    const gate = new SpeechGate();
    expect(gate.feed(silence(500))).toEqual([]);
    expect(gate.feed(tone(100, 40))).toEqual([]); // ≈ −58 dBFS: below the −48 dBFS gate
    expect(gate.isOpen).toBe(false);
    expect(gate.feed(tone(100))).toEqual([{ type: 'open' }]);
    expect(gate.isOpen).toBe(true);
    expect(gate.feed(silence(700))).toEqual([]); // a pause shorter than the window does not split
    expect(gate.feed(tone(100))).toEqual([]);
    const events = gate.feed(silence(800));
    expect(events).toEqual([{ type: 'close', utteranceMs: 900 }]);
    expect(gate.isOpen).toBe(false);
  });

  it('measures quiet on the stream clock — a burst of silence closes instantly, a stall never does', () => {
    const gate = new SpeechGate({ quietMs: 400 });
    gate.feed(tone(60));
    const events = gate.feed(silence(1000)); // 1 s of silence delivered at once
    expect(events).toEqual([{ type: 'close', utteranceMs: 60 }]);
    gate.feed(tone(60));
    expect(gate.isOpen).toBe(true); // no more audio arrives: still open until close() is forced
    expect(gate.close()).toEqual({ type: 'close', utteranceMs: 60 });
    expect(gate.close()).toBeNull();
  });

  it('can open and close within one delta', () => {
    const gate = new SpeechGate({ quietMs: 200 });
    const delta = new Uint8Array([...tone(40), ...silence(200)]);
    expect(gate.feed(delta)).toEqual([{ type: 'open' }, { type: 'close', utteranceMs: 40 }]);
  });

  it('recognizes both μ-law zero encodings as digital silence', () => {
    expect(isDigitalSilence(new Uint8Array([0xff, 0x7f, 0xff]))).toBe(true);
    expect(isDigitalSilence(new Uint8Array([0xff, 0x00]))).toBe(false);
  });
});

describe('TranscriptGrouper (fragments → turns)', () => {
  it('splits on a session-timeline gap and flushes the tail on wall-clock idle', () => {
    vi.useFakeTimers();
    const turns: Array<{ text: string; startMs: number; endMs: number; tag?: string }> = [];
    let tag = 'utt_1';
    const grouper = new TranscriptGrouper({ gapMs: 800, idleMs: 1100, onTurn: (t) => turns.push(t), tagFor: () => tag });
    grouper.push('What', 1000, 1200);
    grouper.push(' is', 1200, 1400);
    tag = 'utt_2';
    grouper.push(' up', 1400, 1600);
    expect(turns).toEqual([]);
    grouper.push('Nothing', 3000, 3200); // 1.4 s gap → previous turn closes
    expect(turns).toEqual([{ text: 'What is up', startMs: 1000, endMs: 1600, tag: 'utt_1' }]);
    vi.advanceTimersByTime(1100);
    expect(turns[1]).toEqual({ text: 'Nothing', startMs: 3000, endMs: 3200, tag: 'utt_2' });
    grouper.push('   ', 5000, 5200);
    grouper.flush(); // whitespace-only turns are dropped
    expect(turns).toHaveLength(2);
    grouper.dispose();
    vi.useRealTimers();
  });
});
