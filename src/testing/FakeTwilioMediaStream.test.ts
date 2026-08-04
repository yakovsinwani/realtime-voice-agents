import { describe, expect, it } from 'vitest';
import { FakeTwilioMediaStream, mulawSilenceBase64 } from './FakeTwilioMediaStream.js';

function markEchoes(fake: FakeTwilioMediaStream): string[] {
  return fake.echoedMarks;
}

describe('FakeTwilioMediaStream playout simulation', () => {
  it('echoes marks only after the media before them has fully played', () => {
    const fake = new FakeTwilioMediaStream();
    fake.send(JSON.stringify({ event: 'media', streamSid: fake.streamSid, media: { payload: mulawSilenceBase64(100) } }));
    fake.send(JSON.stringify({ event: 'mark', streamSid: fake.streamSid, mark: { name: 'r1:0' } }));
    fake.send(JSON.stringify({ event: 'media', streamSid: fake.streamSid, media: { payload: mulawSilenceBase64(60) } }));
    fake.send(JSON.stringify({ event: 'mark', streamSid: fake.streamSid, mark: { name: 'r1:1' } }));

    fake.advancePlayback(50);
    expect(markEchoes(fake)).toEqual([]);
    expect(fake.playedMs).toBe(50);

    fake.advancePlayback(50);
    expect(markEchoes(fake)).toEqual(['r1:0']);

    fake.advancePlayback(59);
    expect(markEchoes(fake)).toEqual(['r1:0']);
    fake.advancePlayback(1);
    expect(markEchoes(fake)).toEqual(['r1:0', 'r1:1']);
    expect(fake.queuedMs).toBe(0);
  });

  it('clear drops buffered audio and echoes all pending marks immediately', () => {
    const fake = new FakeTwilioMediaStream();
    fake.send(JSON.stringify({ event: 'media', streamSid: fake.streamSid, media: { payload: mulawSilenceBase64(500) } }));
    fake.send(JSON.stringify({ event: 'mark', streamSid: fake.streamSid, mark: { name: 'a' } }));
    fake.send(JSON.stringify({ event: 'media', streamSid: fake.streamSid, media: { payload: mulawSilenceBase64(500) } }));
    fake.send(JSON.stringify({ event: 'mark', streamSid: fake.streamSid, mark: { name: 'b' } }));

    fake.advancePlayback(100);
    expect(fake.queuedMs).toBe(900);

    fake.send(JSON.stringify({ event: 'clear', streamSid: fake.streamSid }));
    expect(fake.clearCount).toBe(1);
    expect(fake.queuedMs).toBe(0);
    expect(markEchoes(fake)).toEqual(['a', 'b']);
    // Played time does not advance for discarded audio.
    expect(fake.playedMs).toBe(100);
  });

  it('playAll drains the queue and echoes everything in order', () => {
    const fake = new FakeTwilioMediaStream();
    for (let i = 0; i < 3; i++) {
      fake.send(JSON.stringify({ event: 'media', streamSid: fake.streamSid, media: { payload: mulawSilenceBase64(20) } }));
      fake.send(JSON.stringify({ event: 'mark', streamSid: fake.streamSid, mark: { name: `m${i}` } }));
    }
    fake.playAll();
    expect(markEchoes(fake)).toEqual(['m0', 'm1', 'm2']);
    expect(fake.playedMs).toBe(60);
  });

  it('caller media frames carry a monotonic timestamp', () => {
    const fake = new FakeTwilioMediaStream();
    const timestamps: string[] = [];
    fake.on('message', (data) => {
      const frame = JSON.parse(data);
      if (frame.event === 'media') timestamps.push(frame.media.timestamp);
    });
    fake.connect();
    fake.sendSilence(60);
    expect(timestamps).toEqual(['0', '20', '40']);
  });
});
