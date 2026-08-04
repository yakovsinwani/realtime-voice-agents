/**
 * Generate the bundled background-audio presets as raw 8 kHz μ-law loops.
 * Everything is synthesized (license-free); loops get an equal-power
 * tail-to-head crossfade so they cycle seamlessly, and are normalized quiet
 * (they sit under an active phone call, not on top of it).
 *
 * Run: npm run assets:generate
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 8000;
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../assets');

// ---- μ-law encode (self-contained so the script needs no build) ------------
function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let pcm = Math.round(sample);
  const sign = pcm < 0 ? 0x80 : 0;
  if (sign) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// ---- helpers ---------------------------------------------------------------
const sec = (s: number) => Math.round(s * RATE);

function normalize(samples: Float64Array, peak: number): Float64Array {
  let max = 1e-9;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  const gain = (peak * 32767) / max;
  return samples.map((s) => s * gain) as Float64Array;
}

/** Equal-power tail→head crossfade for seamless looping. */
function crossfadeLoop(samples: Float64Array, fadeSeconds: number): Float64Array {
  const fade = Math.min(sec(fadeSeconds), Math.floor(samples.length / 4));
  const out = new Float64Array(samples.length - fade);
  for (let i = 0; i < out.length; i++) out[i] = samples[i]!;
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const headGain = Math.sin((t * Math.PI) / 2);
    const tailGain = Math.cos((t * Math.PI) / 2);
    out[i] = out[i]! * headGain + samples[out.length + i]! * tailGain;
  }
  return out;
}

function toMulaw(samples: Float64Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) buf[i] = linearToMulaw(samples[i]!);
  return buf;
}

function write(name: string, samples: Float64Array, peak: number, fadeSeconds = 0.25): void {
  const looped = crossfadeLoop(normalize(samples, peak), fadeSeconds);
  const mulaw = toMulaw(looped);
  writeFileSync(path.join(outDir, `${name}.ulaw`), mulaw);
  console.log(`${name}.ulaw  ${(mulaw.length / RATE).toFixed(2)}s  ${(mulaw.length / 1024).toFixed(1)}KB`);
}

// Deterministic noise so regenerating assets is reproducible.
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff - 0.5;
  };
}

// ---- presets ---------------------------------------------------------------

/** US ringback: 440+480 Hz, 2s on / 4s off. */
function ringing(): Float64Array {
  const total = sec(6);
  const out = new Float64Array(total);
  for (let i = 0; i < sec(2); i++) {
    const t = i / RATE;
    const env = Math.min(1, i / sec(0.01), (sec(2) - i) / sec(0.01));
    out[i] = env * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) * 0.5;
  }
  return out;
}

/** Irregular filtered clicks — someone typing at a keyboard. */
function keyboardTyping(): Float64Array {
  const total = sec(6);
  const out = new Float64Array(total);
  const rand = makeRandom(1337);
  let position = sec(0.15);
  while (position < total - sec(0.05)) {
    const clickLen = sec(0.012 + Math.abs(rand()) * 0.02);
    const strength = 0.4 + Math.abs(rand()) * 0.6;
    let lowpass = 0;
    for (let i = 0; i < clickLen && position + i < total; i++) {
      const env = Math.exp((-6 * i) / clickLen);
      lowpass = 0.55 * lowpass + 0.45 * rand();
      out[position + i]! += strength * env * lowpass * 2;
    }
    // Bursts of keystrokes with occasional pauses, like real typing.
    const gap = Math.abs(rand()) < 0.15 ? 0.35 + Math.abs(rand()) * 0.5 : 0.06 + Math.abs(rand()) * 0.12;
    position += sec(gap);
  }
  return out;
}

/** Soft low drone with slow movement — "the agent is thinking". */
function thinkingHum(): Float64Array {
  const total = sec(8);
  const out = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / RATE;
    const lfo = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.23 * t);
    const wobble = 1 + 0.004 * Math.sin(2 * Math.PI * 0.11 * t);
    out[i] =
      lfo *
      (Math.sin(2 * Math.PI * 96 * wobble * t) * 0.7 +
        Math.sin(2 * Math.PI * 144 * wobble * t) * 0.35 +
        Math.sin(2 * Math.PI * 192 * t) * 0.15);
  }
  return out;
}

const NOTES: Record<string, number> = {
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0, B3: 246.94,
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.26,
};

function pluck(out: Float64Array, note: number, startSec: number, durSec: number, amp: number): void {
  const start = sec(startSec);
  const length = sec(durSec);
  for (let i = 0; i < length && start + i < out.length; i++) {
    const t = i / RATE;
    const env = Math.exp(-2.2 * (i / length)) * Math.min(1, i / sec(0.01));
    out[start + i]! +=
      amp *
      env *
      (Math.sin(2 * Math.PI * note * t) * 0.8 +
        Math.sin(2 * Math.PI * note * 2 * t) * 0.25 +
        Math.sin(2 * Math.PI * note * 3 * t) * 0.08);
  }
}

/** Relaxed swung arpeggios over a ii–V–I–vi turnaround. Hold-music classic. */
function elevatorJazz(): Float64Array {
  const total = sec(9.6);
  const out = new Float64Array(total);
  const chords: string[][] = [
    ['D3', 'F3', 'A3', 'C4'], // Dm7
    ['G3', 'B3', 'D4', 'F4'], // G7
    ['C3', 'E3', 'G3', 'B3'], // Cmaj7
    ['A3', 'C4', 'E4', 'G4'], // Am7
  ];
  const swing = [0, 0.34, 0.6, 0.94, 1.2, 1.54, 1.8, 2.14];
  chords.forEach((chord, bar) => {
    const barStart = bar * 2.4;
    swing.forEach((offset, i) => {
      const note = chord[[0, 1, 2, 3, 2, 3, 1, 2][i]!]!;
      pluck(out, NOTES[note]!, barStart + offset, 0.5, i % 2 === 0 ? 0.8 : 0.55);
    });
    // A soft bass note under each bar.
    pluck(out, NOTES[chord[0]!]! / 2, barStart, 2.2, 0.5);
  });
  return out;
}

/** Slow warm chord pad with gentle vinyl-style noise. */
function lofi(): Float64Array {
  const total = sec(9.6);
  const out = new Float64Array(total);
  const rand = makeRandom(4242);
  const chords: string[][] = [
    ['A3', 'C4', 'E4'],
    ['F3', 'A3', 'C4'],
    ['C4', 'E4', 'G4'],
    ['G3', 'B3', 'D4'],
  ];
  chords.forEach((chord, bar) => {
    const start = sec(bar * 2.4);
    const length = sec(2.4);
    chord.forEach((name, voice) => {
      const freq = NOTES[name]!;
      const detune = 1 + (voice - 1) * 0.0012;
      for (let i = 0; i < length && start + i < total; i++) {
        const t = i / RATE;
        const env = Math.min(1, i / sec(0.4), (length - i) / sec(0.6));
        out[start + i]! += 0.5 * env * Math.sin(2 * Math.PI * freq * detune * t);
      }
    });
  });
  // Vinyl crackle: sparse filtered impulses over a faint noise floor.
  let lowpass = 0;
  for (let i = 0; i < total; i++) {
    lowpass = 0.92 * lowpass + 0.08 * rand();
    out[i]! += lowpass * 0.12;
    if (Math.abs(rand()) < 0.0004) out[i]! += rand() * 1.4;
  }
  return out;
}

// ---- main ------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
write('ringing', ringing(), 0.28, 0.02);
write('keyboard-typing', keyboardTyping(), 0.2);
write('thinking-hum', thinkingHum(), 0.12);
write('elevator-jazz', elevatorJazz(), 0.16);
write('lofi', lofi(), 0.14);
console.log('done →', outDir);
