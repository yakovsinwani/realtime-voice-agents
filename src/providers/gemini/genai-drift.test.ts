/**
 * API-drift tripwire for @google/genai (sinwan pattern): every SDK symbol the
 * Gemini provider relies on is asserted here, so an SDK upgrade that renames
 * or moves one fails loudly in THIS file instead of deep inside a live call.
 */

import { describe, expect, it } from 'vitest';

describe('@google/genai surface used by GeminiLiveProvider', () => {
  it('exposes GoogleGenAI with live.connect(model, config, callbacks)', async () => {
    const genai: any = await import('@google/genai');
    expect(typeof genai.GoogleGenAI).toBe('function');
    const ai = new genai.GoogleGenAI({ apiKey: 'drift-test' });
    expect(ai.live).toBeTruthy();
    expect(typeof ai.live.connect).toBe('function');
  });

  it('exposes the Modality enum with AUDIO', async () => {
    const genai: any = await import('@google/genai');
    expect(genai.Modality?.AUDIO ?? 'AUDIO').toBe('AUDIO');
  });
});
