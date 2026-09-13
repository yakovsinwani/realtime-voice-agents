/**
 * Speech gate for full-duplex output streams.
 *
 * GPT-Live streams assistant audio continuously and in real time — silence
 * included (≈100 ms μ-law deltas, digital 0xFF while the model is quiet) —
 * and the wire has no response boundaries: no response.created, no
 * output_audio.done. The engine's playback tracking, tool timing and hangup
 * watchdog all key off `responseStarted` / `responseDone`, so this gate
 * synthesizes utterances from the audio itself: one opens on the first loud
 * 20 ms sub-frame and closes after `quietMs` of quiet AUDIO. Quiet is
 * measured on the stream's own clock (bytes received), never wall-clock, so
 * a stalled socket cannot fake a finished utterance and tests can script
 * silence instantly. Field numbers (Sept 2026, 8 kHz μ-law): quiet frames
 * p99 ≈ −50 dBFS, speech p05 ≈ −44 dBFS; LiveKit and Pipecat both close at
 * 0.8 s.
 */

import { mulawToPcm16 } from '../../audio/mulaw.js';

export interface SpeechGateOptions {
  /** RMS (0..1, full scale = 1) at or above which a 20 ms sub-frame counts as speech. Default 0.004 (≈ −48 dBFS). */
  thresholdRms?: number;
  /** Quiet audio that closes an utterance. Default 800. */
  quietMs?: number;
}

export type SpeechGateEvent = { type: 'open' } | { type: 'close'; utteranceMs: number };

export const DEFAULT_GATE_THRESHOLD_RMS = 0.004;
export const DEFAULT_GATE_QUIET_MS = 800;
const SUBFRAME_BYTES = 160; // 20 ms at 8 kHz μ-law
const BYTES_PER_MS = 8;

export class SpeechGate {
  private readonly threshold: number;
  private readonly quietLimitMs: number;
  private open = false;
  private quietMs = 0;
  private utteranceMs = 0;

  constructor(options: SpeechGateOptions = {}) {
    this.threshold = options.thresholdRms ?? DEFAULT_GATE_THRESHOLD_RMS;
    this.quietLimitMs = options.quietMs ?? DEFAULT_GATE_QUIET_MS;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Feed one output delta; returns the transitions it caused, in order. */
  feed(bytes: Uint8Array): SpeechGateEvent[] {
    const events: SpeechGateEvent[] = [];
    for (let offset = 0; offset < bytes.length; offset += SUBFRAME_BYTES) {
      const frame = bytes.subarray(offset, Math.min(offset + SUBFRAME_BYTES, bytes.length));
      const frameMs = frame.length / BYTES_PER_MS;
      if (isSpeech(frame, this.threshold)) {
        if (!this.open) {
          this.open = true;
          this.utteranceMs = 0;
          events.push({ type: 'open' });
        }
        this.quietMs = 0;
        this.utteranceMs += frameMs;
      } else if (this.open) {
        this.quietMs += frameMs;
        this.utteranceMs += frameMs;
        if (this.quietMs >= this.quietLimitMs) {
          events.push({ type: 'close', utteranceMs: this.utteranceMs - this.quietMs });
          this.open = false;
          this.quietMs = 0;
          this.utteranceMs = 0;
        }
      }
    }
    return events;
  }

  /** Force-close an open utterance (stream stalled, session closing). */
  close(): SpeechGateEvent | null {
    if (!this.open) return null;
    const event: SpeechGateEvent = { type: 'close', utteranceMs: this.utteranceMs - this.quietMs };
    this.open = false;
    this.quietMs = 0;
    this.utteranceMs = 0;
    return event;
  }
}

/** μ-law digital zero is 0xFF (some encoders emit 0x7F for negative zero). */
export function isDigitalSilence(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b !== 0xff && b !== 0x7f) return false;
  }
  return true;
}

function isSpeech(frame: Uint8Array, threshold: number): boolean {
  if (frame.length === 0 || isDigitalSilence(frame)) return false;
  const pcm = mulawToPcm16(frame);
  let acc = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]! / 32768;
    acc += v * v;
  }
  return Math.sqrt(acc / pcm.length) >= threshold;
}
