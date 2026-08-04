import { describe, expect, it } from 'vitest';
import {
  MULAW_SILENCE_BYTE,
  base64ByteLength,
  mulawBytesToMs,
  mulawDecodeSample,
  mulawEncodeSample,
  mulawToPcm16,
  pcm16ToMulaw,
} from './mulaw.js';

describe('mulaw codec', () => {
  it('matches known G.711 reference values', () => {
    expect(mulawDecodeSample(0x00)).toBe(-32124);
    expect(mulawDecodeSample(0x80)).toBe(32124);
    expect(mulawDecodeSample(0xff)).toBe(0);
    expect(mulawDecodeSample(0x7f)).toBe(0); // -0 code; Int16Array normalizes to +0
    expect(mulawEncodeSample(0)).toBe(0xff);
    expect(mulawEncodeSample(-32124)).toBe(0x00);
    expect(mulawEncodeSample(32124)).toBe(0x80);
  });

  it('round-trips every byte value (except the redundant -0 code)', () => {
    for (let b = 0; b < 256; b++) {
      if (b === 0x7f) continue; // -0 re-encodes as +0 (0xff); both decode to 0
      expect(mulawEncodeSample(mulawDecodeSample(b))).toBe(b);
    }
    expect(mulawEncodeSample(mulawDecodeSample(0x7f))).toBe(0xff);
  });

  it('encode → decode error stays within the μ-law quantization step', () => {
    for (let s = -32768; s <= 32767; s += 37) {
      const decoded = mulawDecodeSample(mulawEncodeSample(s));
      const clipped = Math.max(-32635, Math.min(32635, s));
      // μ-law segments double in width; max step at the top segment is 1024.
      expect(Math.abs(decoded - clipped)).toBeLessThanOrEqual(512);
    }
  });

  it('buffer helpers round-trip and silence byte decodes to 0', () => {
    const pcm = new Int16Array([0, 1000, -1000, 32000, -32000]);
    const round = mulawToPcm16(pcm16ToMulaw(pcm));
    for (let i = 0; i < pcm.length; i++) {
      expect(Math.abs(round[i]! - pcm[i]!)).toBeLessThanOrEqual(1024);
    }
    expect(mulawDecodeSample(MULAW_SILENCE_BYTE)).toBe(0);
  });

  it('mulawBytesToMs converts at 8 bytes per millisecond', () => {
    expect(mulawBytesToMs(160)).toBe(20);
    expect(mulawBytesToMs(8000)).toBe(1000);
  });

  it('base64ByteLength matches actual decoded length', () => {
    for (const len of [0, 1, 2, 3, 4, 159, 160, 161]) {
      const b64 = Buffer.alloc(len, 7).toString('base64');
      expect(base64ByteLength(b64)).toBe(len);
    }
  });
});
