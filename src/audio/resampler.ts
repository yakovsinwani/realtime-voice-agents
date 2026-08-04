/**
 * Stateful polyphase FIR sample-rate converter.
 *
 * Built for streaming telephony audio: the instance carries the FIR history
 * across process() calls, so chunk boundaries produce bit-identical output to
 * single-pass processing — no per-chunk zero-padding, no boundary clicks.
 * Coefficients are computed once per (from, to, quality) in a module cache.
 *
 * Rational L/M design: the prototype lowpass is a Kaiser-windowed sinc at the
 * upsampled rate (from × L), decomposed into L phases of N/L taps. Each phase
 * is normalized to unit DC gain so constant signals pass through exactly.
 */

export interface ResamplerOptions {
  /**
   * Prototype filter length multiplier. The prototype has
   * `quality × max(L, M)` taps (rounded up to a multiple of L); higher is
   * cleaner and slower. Default 48 (≈70–80 dB alias rejection for 24k→8k).
   */
  quality?: number;
  /** Kaiser window beta. Default 8. */
  kaiserBeta?: number;
  /** Passband edge as a fraction of the tighter Nyquist. Default 0.9. */
  rolloff?: number;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** Modified Bessel function of the first kind, order zero (series expansion). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

interface FilterBank {
  /** L phase filters, each `tapsPerPhase` long. */
  phases: Float64Array[];
  tapsPerPhase: number;
}

const bankCache = new Map<string, FilterBank>();

function designBank(L: number, M: number, opts: Required<ResamplerOptions>): FilterBank {
  const key = `${L}/${M}/${opts.quality}/${opts.kaiserBeta}/${opts.rolloff}`;
  const cached = bankCache.get(key);
  if (cached) return cached;

  let n = opts.quality * Math.max(L, M);
  n = Math.ceil(n / L) * L;
  // Cutoff in cycles/sample at the upsampled rate: the tighter of the input
  // and output Nyquist frequencies, backed off by the rolloff factor.
  const fc = (opts.rolloff * 0.5) / Math.max(L, M);
  const center = (n - 1) / 2;
  const denom = besselI0(opts.kaiserBeta);

  const proto = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = i - center;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const r = (2 * i) / (n - 1) - 1;
    const window = besselI0(opts.kaiserBeta * Math.sqrt(1 - r * r)) / denom;
    proto[i] = sinc * window;
  }

  const tapsPerPhase = n / L;
  const phases: Float64Array[] = [];
  for (let p = 0; p < L; p++) {
    const phase = new Float64Array(tapsPerPhase);
    let sum = 0;
    for (let t = 0; t < tapsPerPhase; t++) {
      phase[t] = proto[p + t * L]!;
      sum += phase[t]!;
    }
    // Unit DC gain per phase: exact passthrough for constant signals.
    if (sum !== 0) for (let t = 0; t < tapsPerPhase; t++) phase[t]! /= sum;
    phases.push(phase);
  }

  const bank = { phases, tapsPerPhase };
  bankCache.set(key, bank);
  return bank;
}

export class Resampler {
  readonly fromRate: number;
  readonly toRate: number;
  private readonly L: number;
  private readonly M: number;
  private readonly bank: FilterBank;
  /** Trailing input samples carried between chunks (tapsPerPhase − 1 long). */
  private hist: Int16Array;
  /** Phase index of the next output sample. */
  private phase = 0;
  /**
   * Input index (relative to the start of the next [hist + chunk] buffer) that
   * the next output sample is anchored on. Always ≥ tapsPerPhase − 1.
   */
  private kRel: number;

  constructor(fromRate: number, toRate: number, options: ResamplerOptions = {}) {
    if (!Number.isInteger(fromRate) || !Number.isInteger(toRate) || fromRate <= 0 || toRate <= 0) {
      throw new RangeError(`invalid sample rates: ${fromRate} -> ${toRate}`);
    }
    this.fromRate = fromRate;
    this.toRate = toRate;
    const g = gcd(fromRate, toRate);
    this.L = toRate / g;
    this.M = fromRate / g;
    this.bank = designBank(this.L, this.M, {
      quality: options.quality ?? 48,
      kaiserBeta: options.kaiserBeta ?? 8,
      rolloff: options.rolloff ?? 0.9,
    });
    this.hist = new Int16Array(this.bank.tapsPerPhase - 1);
    this.kRel = this.bank.tapsPerPhase - 1;
  }

  /** True when no rate conversion is needed (input is passed through). */
  get isPassthrough(): boolean {
    return this.L === 1 && this.M === 1;
  }

  process(input: Int16Array): Int16Array {
    if (this.isPassthrough) return input;
    const { phases, tapsPerPhase } = this.bank;
    const histLen = this.hist.length;
    const buf = new Int16Array(histLen + input.length);
    buf.set(this.hist, 0);
    buf.set(input, histLen);

    const maxOut = Math.ceil(((buf.length - this.kRel) * this.L) / this.M) + 1;
    const out = new Int16Array(Math.max(maxOut, 0));
    let produced = 0;

    let k = this.kRel;
    let p = this.phase;
    while (k < buf.length) {
      const coeffs = phases[p]!;
      let acc = 0;
      for (let t = 0; t < tapsPerPhase; t++) acc += coeffs[t]! * buf[k - t]!;
      let sample = Math.round(acc);
      if (sample > 32767) sample = 32767;
      else if (sample < -32768) sample = -32768;
      out[produced++] = sample;
      p += this.M;
      k += (p / this.L) | 0;
      p %= this.L;
    }

    // Retain the last tapsPerPhase − 1 samples and rebase k onto the next buffer.
    const keepFrom = buf.length - histLen;
    this.hist = buf.slice(keepFrom);
    this.kRel = k - keepFrom;
    this.phase = p;

    return out.subarray(0, produced);
  }

  /** Drain the filter tail by pushing one phase-length of silence. */
  flush(): Int16Array {
    if (this.isPassthrough) return new Int16Array(0);
    return this.process(new Int16Array(this.bank.tapsPerPhase));
  }

  /** Clear all carried state (history, phase) for reuse on a fresh stream. */
  reset(): void {
    this.hist = new Int16Array(this.bank.tapsPerPhase - 1);
    this.phase = 0;
    this.kRel = this.bank.tapsPerPhase - 1;
  }
}
