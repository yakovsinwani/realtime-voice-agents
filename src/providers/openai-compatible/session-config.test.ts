import { describe, expect, it } from 'vitest';
import { buildSessionUpdate, buildTurnDetection } from './session-config.js';

describe('buildTurnDetection', () => {
  it('defaults to server_vad', () => {
    expect(buildTurnDetection(undefined)).toEqual({ type: 'server_vad' });
  });

  it('maps normalized server VAD fields to wire names', () => {
    expect(
      buildTurnDetection({ type: 'server', threshold: 0.7, silenceDurationMs: 700, prefixPaddingMs: 300 }),
    ).toEqual({ type: 'server_vad', threshold: 0.7, silence_duration_ms: 700, prefix_padding_ms: 300 });
  });

  it('maps semantic VAD and null-disable', () => {
    expect(buildTurnDetection({ type: 'semantic', eagerness: 'high' })).toEqual({
      type: 'semantic_vad',
      eagerness: 'high',
    });
    expect(buildTurnDetection(null)).toBeNull();
  });
});

describe('buildSessionUpdate (GA)', () => {
  const init = {
    instructions: 'Be helpful on the phone.',
    voice: 'marin',
    tools: [
      { name: 'lookup', description: 'Lookup an order', parameters: { type: 'object', properties: {} } },
    ],
    transcription: { language: 'en' },
  };

  it('produces the GA nested audio shape with pcmu both directions', () => {
    const payload = buildSessionUpdate(init) as any;
    expect(payload.type).toBe('session.update');
    expect(payload.session.type).toBe('realtime');
    expect(payload.session.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(payload.session.audio.output.format).toEqual({ type: 'audio/pcmu' });
    expect(payload.session.audio.output.voice).toBe('marin');
    expect(payload.session.audio.input.turn_detection).toEqual({ type: 'server_vad' });
    expect(payload.session.audio.input.transcription).toEqual({
      model: 'gpt-4o-mini-transcribe',
      language: 'en',
    });
    expect(payload.session.tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'Lookup an order',
        parameters: { type: 'object', properties: {} },
      },
    ]);
    // The beta-only flat fields must never appear.
    expect(payload.session.input_audio_format).toBeUndefined();
    expect(payload.session.voice).toBeUndefined();
  });

  it('disables turn detection with explicit null (GA semantics)', () => {
    const payload = buildSessionUpdate({ ...init, vad: null }) as any;
    expect(payload.session.audio.input.turn_detection).toBeNull();
  });

  it('omits transcription when disabled', () => {
    const payload = buildSessionUpdate({ ...init, transcription: false }) as any;
    expect(payload.session.audio.input.transcription).toBeUndefined();
  });

  it('deep-merges providerOptions and extraSessionOptions last', () => {
    const payload = buildSessionUpdate(
      { ...init, providerOptions: { audio: { input: { noise_reduction: { type: 'near_field' } } } } },
      { extraSessionOptions: { max_output_tokens: 500 } },
    ) as any;
    expect(payload.session.audio.input.noise_reduction).toEqual({ type: 'near_field' });
    expect(payload.session.audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect(payload.session.max_output_tokens).toBe(500);
  });

  it('falls back to the config default voice', () => {
    const payload = buildSessionUpdate({ ...init, voice: undefined }, { defaultVoice: 'cedar' }) as any;
    expect(payload.session.audio.output.voice).toBe('cedar');
  });
});
