import { describe, expect, it } from 'vitest';
import { buildXaiSessionUpdate } from './xai.js';

describe('buildXaiSessionUpdate', () => {
  const init = {
    instructions: 'Answer the phone.',
    voice: 'eve',
    vad: { type: 'server' as const, threshold: 0.85 },
    tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    transcription: { language: 'en' },
  };

  it('places voice and turn_detection at the session root (xAI shape)', () => {
    const payload = buildXaiSessionUpdate(init) as any;
    expect(payload.type).toBe('session.update');
    expect(payload.session.voice).toBe('eve');
    expect(payload.session.turn_detection).toEqual({ type: 'server_vad', threshold: 0.85 });
    // ...unlike OpenAI GA, where they live under session.audio.
    expect(payload.session.audio.output.voice).toBeUndefined();
    expect(payload.session.audio.input.turn_detection).toBeUndefined();
  });

  it('pins audio/pcmu at 8000 Hz both directions', () => {
    const payload = buildXaiSessionUpdate(init) as any;
    expect(payload.session.audio.input.format).toEqual({ type: 'audio/pcmu', rate: 8000 });
    expect(payload.session.audio.output.format).toEqual({ type: 'audio/pcmu', rate: 8000 });
  });

  it('maps transcription language to language_hint', () => {
    const payload = buildXaiSessionUpdate(init) as any;
    expect(payload.session.audio.input.transcription).toEqual({ language_hint: 'en' });
  });

  it('falls back to the config default voice', () => {
    const payload = buildXaiSessionUpdate({ ...init, voice: undefined }, { defaultVoice: 'rex' }) as any;
    expect(payload.session.voice).toBe('rex');
  });
});
