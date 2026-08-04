/**
 * BackgroundAudioPlayer — paced μ-law loop injection into the Twilio stream.
 *
 * Twilio has ONE sequential playout buffer, so background audio must be paced
 * in near-realtime (never bulk-queued): frames-due are computed from the wall
 * clock each tick (drift-corrected), with a small burst cap, keeping at most
 * a few frames buffered ahead. That way, when real agent audio arrives it
 * queues at most ~2 frames behind the hold loop instead of seconds.
 *
 * Safety rails from production systems: a generation counter invalidates
 * orphan intervals after stop/restart races; a hard max-duration failsafe
 * stops a hung tool from looping forever; refcounted acquire/release lets
 * concurrent tools share one loop; a start delay keeps fast tools silent.
 */

import { fadeMulaw, scaleMulaw } from '../gain.js';
import { MULAW_FRAME_BYTES_20MS } from '../mulaw.js';
import { loadBackgroundAudio, presetLabel } from './loader.js';
import type { BackgroundAudioOptions, BackgroundAudioSpec } from './presets.js';

const FRAME_MS = 20;
const MAX_BURST_FRAMES = 5;

export interface BackgroundAudioPlayerDeps {
  sendMedia: (base64Payload: string) => void;
  onStarted?: (info: { preset?: string }) => void;
  onStopped?: (info: { preset?: string }) => void;
  now?: () => number;
}

interface ActiveLoop {
  generation: number;
  buffer: Buffer;
  scaled: Buffer;
  preset?: string;
  offset: number;
  startedAt: number;
  framesSent: number;
  fadeInFramesLeft: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  interval: NodeJS.Timeout;
  failsafe: NodeJS.Timeout;
}

export class BackgroundAudioPlayer {
  private readonly deps: BackgroundAudioPlayerDeps;
  private readonly now: () => number;
  private generation = 0;
  private active: ActiveLoop | null = null;
  private startDelayTimer: NodeJS.Timeout | null = null;
  /** Tool-call ids currently holding the loop. */
  private readonly holders = new Set<string>();
  private pendingSpec: { spec: BackgroundAudioSpec; options: BackgroundAudioOptions } | null = null;

  constructor(deps: BackgroundAudioPlayerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  get isPlaying(): boolean {
    return this.active !== null;
  }

  /**
   * Refcounted acquisition (one holder per tool call). The loop starts after
   * `startDelayMs` unless every holder releases first.
   */
  acquire(holderId: string, spec: BackgroundAudioSpec, options: BackgroundAudioOptions = {}): void {
    this.holders.add(holderId);
    if (this.active || this.startDelayTimer) return;
    this.pendingSpec = { spec, options };
    const delay = options.startDelayMs ?? 1000;
    if (delay <= 0) {
      this.startNow();
      return;
    }
    this.startDelayTimer = setTimeout(() => {
      this.startDelayTimer = null;
      if (this.holders.size > 0) this.startNow();
    }, delay);
    this.startDelayTimer.unref?.();
  }

  /** Release one holder; the loop stops when the last holder releases. */
  release(holderId: string, opts: { immediate?: boolean } = {}): void {
    this.holders.delete(holderId);
    if (this.holders.size > 0) return;
    this.stop({ immediate: opts.immediate });
  }

  /** Direct start (facade `playBackgroundAudio`). Bypasses refcounting. */
  start(spec: BackgroundAudioSpec, options: BackgroundAudioOptions = {}): void {
    this.holders.add('__manual__');
    this.cancelDelay();
    this.pendingSpec = { spec, options };
    this.startNow();
  }

  /**
   * Stop the loop. Fade-out is applied when `immediate` is false and a
   * fadeOutMs was configured; agent-audio preemption should pass
   * `immediate: true` (a fade would delay real speech behind it).
   */
  stop(opts: { immediate?: boolean } = {}): void {
    this.holders.clear();
    this.cancelDelay();
    this.pendingSpec = null;
    const active = this.active;
    if (!active) return;
    this.generation++;
    clearInterval(active.interval);
    clearTimeout(active.failsafe);
    this.active = null;
    const fadeOutMs = opts.immediate ? 0 : (active.fadeOutMs ?? 0);
    if (fadeOutMs > 0) {
      // One final ramped-to-silence stretch of the loop.
      const frames = Math.min(Math.ceil(fadeOutMs / FRAME_MS), 25);
      let offset = active.offset;
      for (let i = 0; i < frames; i++) {
        const frame = this.extractFrame(active.scaled, offset);
        offset = frame.nextOffset;
        const gainStart = 1 - i / frames;
        const gainEnd = 1 - (i + 1) / frames;
        this.deps.sendMedia(Buffer.from(fadeMulaw(frame.frame, gainStart, gainEnd)).toString('base64'));
      }
    }
    this.deps.onStopped?.({ preset: active.preset });
  }

  /** Real agent audio arrived — kill the loop instantly, no fade, no clear. */
  notifyAgentAudio(): void {
    if (!this.active && !this.startDelayTimer) return;
    this.stop({ immediate: true });
  }

  private cancelDelay(): void {
    if (this.startDelayTimer) {
      clearTimeout(this.startDelayTimer);
      this.startDelayTimer = null;
    }
  }

  private startNow(): void {
    if (this.active || !this.pendingSpec) return;
    const { spec, options } = this.pendingSpec;
    this.pendingSpec = null;
    let buffer: Buffer;
    try {
      buffer = loadBackgroundAudio(spec);
    } catch {
      return; // a missing asset must never break a live call
    }
    if (buffer.length < MULAW_FRAME_BYTES_20MS) return;

    const volume = options.volume ?? 0.4;
    const scaled =
      volume === 1
        ? buffer
        : Buffer.from(scaleMulaw(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length), volume));
    const generation = ++this.generation;
    const fadeInMs = options.fadeInMs ?? 200;

    const loop: ActiveLoop = {
      generation,
      buffer,
      scaled,
      preset: presetLabel(spec),
      offset: 0,
      startedAt: this.now(),
      framesSent: 0,
      fadeInFramesLeft: Math.ceil(fadeInMs / FRAME_MS),
      volume,
      fadeInMs,
      fadeOutMs: options.fadeOutMs ?? 200,
      interval: setInterval(() => this.tick(generation), FRAME_MS),
      failsafe: setTimeout(() => {
        if (this.active?.generation === generation) this.stop({ immediate: true });
      }, options.maxDurationMs ?? 60_000),
    };
    loop.interval.unref?.();
    loop.failsafe.unref?.();
    this.active = loop;
    this.deps.onStarted?.({ preset: loop.preset });
  }

  private tick(generation: number): void {
    const active = this.active;
    if (!active || active.generation !== generation) return;
    const elapsed = this.now() - active.startedAt;
    const framesDue = Math.floor(elapsed / FRAME_MS) + 1 - active.framesSent;
    const toSend = Math.min(Math.max(framesDue, 0), MAX_BURST_FRAMES);
    for (let i = 0; i < toSend; i++) {
      const { frame, nextOffset } = this.extractFrame(active.scaled, active.offset);
      active.offset = nextOffset;
      let payload = frame;
      if (active.fadeInFramesLeft > 0) {
        const total = Math.ceil(active.fadeInMs / FRAME_MS);
        const index = total - active.fadeInFramesLeft;
        payload = fadeMulaw(frame, index / total, (index + 1) / total);
        active.fadeInFramesLeft--;
      }
      this.deps.sendMedia(Buffer.from(payload).toString('base64'));
      active.framesSent++;
    }
  }

  /** Wrap-around frame extraction for seamless looping. */
  private extractFrame(buffer: Buffer, offset: number): { frame: Uint8Array; nextOffset: number } {
    const size = MULAW_FRAME_BYTES_20MS;
    if (offset + size <= buffer.length) {
      return {
        frame: new Uint8Array(buffer.buffer, buffer.byteOffset + offset, size),
        nextOffset: (offset + size) % buffer.length,
      };
    }
    const frame = new Uint8Array(size);
    const tail = buffer.length - offset;
    frame.set(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, tail), 0);
    frame.set(new Uint8Array(buffer.buffer, buffer.byteOffset, size - tail), tail);
    return { frame, nextOffset: size - tail };
  }
}
