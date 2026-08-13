/**
 * Noise-adaptive VAD end-to-end: FakeTwilioMediaStream (the caller) ⇄ bridge ⇄
 * OpenAICompatibleProvider ⇄ FakeOpenAIServer. All detection clocks are in
 * milliseconds of inbound audio, so scenarios are deterministic — no fake
 * timers. The tiny window/sustain/cooldown values below keep every trigger a
 * handful of 20 ms frames away.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../agents/Agent.js';
import { pcm16ToMulaw } from '../audio/mulaw.js';
import { openaiRealtime } from '../openai.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible/OpenAICompatibleProvider.js';
import { FakeOpenAIServer } from '../testing/FakeOpenAIServer.js';
import { FakeTwilioMediaStream, mulawSilenceBase64 } from '../testing/FakeTwilioMediaStream.js';
import { TwilioRealtimeBridge } from './TwilioRealtimeBridge.js';
import type { BridgeConfig, SessionOptions } from './config.js';
import type { CallSession } from './CallSession.js';
import type { VadSuggestionInfo } from './events.js';
import type { VadAdjustment } from '../vad/NoiseAdaptiveVadController.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** 20 ms base64 μ-law frames of a continuous 440 Hz tone. 1465 ≈ −30 dBFS. */
function noiseFrames(ms: number, amplitude = 1465): string[] {
  const frames: string[] = [];
  for (let start = 0; start < ms; start += 20) {
    const pcm = new Int16Array(160);
    for (let i = 0; i < 160; i++) {
      const sample = start * 8 + i; // continuous phase across frames
      pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * sample) / 8000));
    }
    frames.push(Buffer.from(pcm16ToMulaw(pcm)).toString('base64'));
  }
  return frames;
}

/** Louder tone standing in for caller speech (≈ −15 dBFS). */
const speechLikeFrames = (ms: number) => noiseFrames(ms, 8241);

const vadOf = (frame: Record<string, any>) => (frame.session as any)?.audio?.input?.turn_detection;

// window 200 (10 frames) + sustain 100 (5 frames) ⇒ first trigger ≈ 15 frames;
// cooldown 300 ⇒ 15 more frames between steps.
const FAST_ADAPTIVE = { windowMs: 200, sustainMs: 100, cooldownMs: 300, maxSteps: 2 };
const FAST_RECONNECT = { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 20, jitter: false };

describe('noise-adaptive VAD (FakeTwilio ⇄ bridge ⇄ FakeOpenAI)', () => {
  let server: FakeOpenAIServer;
  let bridge: TwilioRealtimeBridge;
  let fake: FakeTwilioMediaStream;

  const makeBridge = (overrides: Partial<BridgeConfig> = {}, session: Partial<SessionOptions> = {}) =>
    new TwilioRealtimeBridge({
      agent: new Agent({
        name: 'Receptionist',
        instructions: 'You answer the phone briefly.',
        voice: 'marin',
      }),
      provider: openaiRealtime({ apiKey: 'test', baseUrl: server.url }),
      session: {
        greeting: { mode: 'user-initiates' },
        vad: { type: 'server', threshold: 0.5, silenceDurationMs: 700 },
        noiseAdaptiveVad: FAST_ADAPTIVE,
        ...session,
      },
      ...overrides,
    });

  const connectCall = async (): Promise<CallSession> => {
    fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active session');
    return bridge.getSession(fake.callSid)!;
  };

  /** For servers with autoAckSessionUpdate: false — ack the handshake by hand. */
  const connectCallManualAck = async (): Promise<CallSession> => {
    fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    const conn = await server.waitForConnection();
    await conn.waitForEvent('session.update');
    conn.send({ type: 'session.updated', session: {} });
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active session');
    return bridge.getSession(fake.callSid)!;
  };

  const useManualAckServer = async (): Promise<void> => {
    await server.close();
    server = await FakeOpenAIServer.start({ autoAckSessionUpdate: false });
  };

  const feed = (frames: string[]) => {
    for (const frame of frames) fake.sendMedia(frame);
  };

  const updates = () => server.latest.eventsOfType('session.update');

  beforeEach(async () => {
    server = await FakeOpenAIServer.start();
  });

  afterEach(async () => {
    await bridge?.close();
    await server.close();
  });

  it('auto mode: escalates 0.5 → 0.6 → 0.7 on sustained noise, ack-gated, capped by maxSteps', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const suggestions: VadSuggestionInfo[] = [];
    const adjusted: VadAdjustment[] = [];
    session.on('vad.suggestion', (info) => suggestions.push(info));
    session.on('vad.adjusted', (info) => adjusted.push(info));

    feed(noiseFrames(400));
    await waitFor(() => adjusted.length === 1, 2000, 'first adjustment');
    // Gotcha-1 regression, pinned at the wire: the vad patch keeps both the
    // explicit session fields AND the injected interrupt_response: false.
    expect(vadOf(updates()[1]!)).toEqual({
      type: 'server_vad',
      threshold: 0.6,
      silence_duration_ms: 700,
      interrupt_response: false,
    });
    expect(suggestions[0]!.willAutoApply).toBe(true);
    expect(suggestions[0]!.autoApplicable).toBe(true);
    expect(adjusted[0]!.suggested.threshold).toBe(0.6);
    expect(adjusted[0]!.previous.threshold).toBe(0.5);

    feed(noiseFrames(400));
    await waitFor(() => adjusted.length === 2, 2000, 'second adjustment');
    expect(vadOf(updates()[2]!).threshold).toBe(0.7);

    feed(noiseFrames(800));
    await delay(60);
    expect(updates()).toHaveLength(3); // maxSteps: 2 — no fourth update, ever
  });

  it('sends exactly ONE adaptive update while its ack is pending (in-flight gate)', async () => {
    await useManualAckServer();
    bridge = makeBridge();
    const session = await connectCallManualAck();
    const adjusted: VadAdjustment[] = [];
    session.on('vad.adjusted', (info) => adjusted.push(info));

    feed(noiseFrames(1000)); // dozens of recurring proposals — all gated after the first send
    await delay(50);
    expect(updates()).toHaveLength(2); // handshake + ONE vad update
    expect(adjusted).toHaveLength(0); // nothing committed before the ack

    server.latest.send({ type: 'session.updated', session: {} });
    await waitFor(() => adjusted.length === 1, 2000, 'adjustment after ack');
  });

  it('adaptive ack timeout ⇒ desync-reconnect with the KNOWN-GOOD config (0.5, not the unacked 0.6)', async () => {
    await useManualAckServer();
    bridge = makeBridge({
      provider: ({ logger }) =>
        new OpenAICompatibleProvider(
          {
            apiKey: 'test',
            model: 'gpt-realtime',
            baseUrl: server.url,
            sessionUpdateAckTimeoutMs: 120,
            capabilityOverrides: {
              vadTuning: { defaultServerThreshold: 0.5, minServerThreshold: 0, maxServerThreshold: 1 },
            },
          },
          logger,
        ),
    }, { reconnect: FAST_RECONNECT });
    const session = await connectCallManualAck();
    const adjusted: VadAdjustment[] = [];
    session.on('vad.adjusted', (info) => adjusted.push(info));

    feed(noiseFrames(400));
    await waitFor(() => updates().length === 2, 2000, 'adaptive update sent');
    // Withhold the ack: the provider desyncs and drops the socket.
    await waitFor(() => server.connections.length === 2, 3000, 'reconnect connection');
    const reconn = server.connections[1]!;
    const handshake = await reconn.waitForEvent('session.update');
    // The unacked 0.6 was never promoted — reconnect restores known-good 0.5.
    expect(vadOf(handshake).threshold).toBe(0.5);
    expect(adjusted).toHaveLength(0);

    reconn.send({ type: 'session.updated', session: {} });
    await waitFor(() => session.state === 'active' && reconn.received.length > 0, 2000, 'reconnected');

    // The line is still noisy: adaptation retries after cooldown and commits this time.
    feed(noiseFrames(800));
    await waitFor(() => reconn.eventsOfType('session.update').length === 2, 2000, 'retried escalation');
    expect(vadOf(reconn.eventsOfType('session.update')[1]!).threshold).toBe(0.6);
    reconn.send({ type: 'session.updated', session: {} });
    await waitFor(() => adjusted.length === 1, 2000, 'adjustment after retry');
  });

  it('manual updateVad ack timeout keeps the USER intent: reconnect carries 0.8', async () => {
    await useManualAckServer();
    bridge = makeBridge({
      provider: ({ logger }) =>
        new OpenAICompatibleProvider(
          { apiKey: 'test', model: 'gpt-realtime', baseUrl: server.url, sessionUpdateAckTimeoutMs: 120 },
          logger,
        ),
    }, { reconnect: FAST_RECONNECT });
    const session = await connectCallManualAck();

    const applied = await session.updateVad({ type: 'server', threshold: 0.8 });
    expect(applied).toBe(false); // sent but never acknowledged

    await waitFor(() => server.connections.length === 2, 3000, 'reconnect connection');
    const handshake = await server.connections[1]!.waitForEvent('session.update');
    expect(vadOf(handshake)).toEqual({
      type: 'server_vad',
      threshold: 0.8,
      interrupt_response: false,
    });
  });

  it('manual updateVad supersedes an in-flight adaptive apply (never 0.8 → 0.6)', async () => {
    await useManualAckServer();
    bridge = makeBridge();
    const session = await connectCallManualAck();
    const suggestions: VadSuggestionInfo[] = [];
    const adjusted: VadAdjustment[] = [];
    session.on('vad.suggestion', (info) => suggestions.push(info));
    session.on('vad.adjusted', (info) => adjusted.push(info));

    feed(noiseFrames(400));
    await waitFor(() => updates().length === 2, 2000, 'adaptive 0.6 in flight');
    const manual = session.updateVad({ type: 'server', threshold: 0.8 }); // queued behind the unacked 0.6

    // Keep the noise coming while both are pending: the shared gate must hold.
    feed(noiseFrames(600));
    await delay(50);
    expect(updates()).toHaveLength(2);

    server.latest.send({ type: 'session.updated', session: {} }); // acks the adaptive 0.6…
    await waitFor(() => updates().length === 3, 2000, 'manual update sent');
    expect(vadOf(updates()[2]!).threshold).toBe(0.8);
    server.latest.send({ type: 'session.updated', session: {} }); // …and now the manual 0.8
    await expect(manual).resolves.toBe(true);
    // …but the 0.6 ack was discarded: superseded by the manual revision.
    expect(adjusted).toHaveLength(0);

    // Future escalation is relative to the manual override.
    feed(noiseFrames(800));
    await waitFor(() => updates().length === 4, 2000, 'escalation from 0.8');
    expect(vadOf(updates()[3]!).threshold).toBe(0.9);
    server.latest.send({ type: 'session.updated', session: {} });
    await waitFor(() => adjusted.length === 1, 2000, 'post-rebase adjustment');
    expect(adjusted[0]!.suggested.threshold).toBe(0.9);
    expect(adjusted[0]!.previous.threshold).toBe(0.8);
  });

  it('continuous quiet speech never escalates (speech exclusion)', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const suggestions: VadSuggestionInfo[] = [];
    session.on('vad.suggestion', (info) => suggestions.push(info));
    let speechStarted = 0;
    session.on('user.speech.started', () => speechStarted++);

    server.latest.sendSpeechStarted();
    await waitFor(() => speechStarted === 1, 2000, 'speech flag set');
    feed(speechLikeFrames(10_000)); // a 10s monologue in a quiet room
    server.latest.sendSpeechStopped();
    await delay(50);

    expect(suggestions).toHaveLength(0);
    expect(updates()).toHaveLength(1);
  });

  it('agent-audio speakerphone bleed never escalates (playback exclusion)', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const suggestions: VadSuggestionInfo[] = [];
    session.on('vad.suggestion', (info) => suggestions.push(info));

    // 2s of agent audio queued at Twilio, NOT yet played out: playback active.
    server.latest.sendAudioResponse({ responseId: 'talk', chunks: [mulawSilenceBase64(2000)] });
    await waitFor(() => fake.sentMediaPayloads.length >= 1, 2000, 'agent audio at Twilio');

    feed(noiseFrames(1000, 8241)); // loud bleed while the agent is talking
    await delay(50);
    expect(suggestions).toHaveLength(0);

    fake.playAll(); // playback ends; the line goes quiet
    feed(noiseFrames(400, 0)); // silence
    await delay(50);
    expect(suggestions).toHaveLength(0);
    expect(updates()).toHaveLength(1);
  });

  it('phantom speech_started/stopped churn on a noisy line still escalates', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const adjusted: VadAdjustment[] = [];
    session.on('vad.adjusted', (info) => adjusted.push(info));
    let started = 0;
    let ended = 0;
    session.on('user.speech.started', () => started++);
    session.on('user.speech.ended', () => ended++);

    // Noise keeps tripping the server VAD: brief phantom "speech" bursts with
    // noisy gaps between them. The estimator learns in the gaps.
    for (let round = 1; round <= 6 && adjusted.length === 0; round++) {
      server.latest.sendSpeechStarted();
      await waitFor(() => started === round, 2000, 'phantom start');
      feed(noiseFrames(100)); // excluded while "speaking"
      server.latest.sendSpeechStopped();
      await waitFor(() => ended === round, 2000, 'phantom stop');
      feed(noiseFrames(200)); // analyzed gap
      await delay(10);
    }
    await waitFor(() => adjusted.length >= 1, 2000, 'escalation despite churn');
    expect(adjusted[0]!.suggested.threshold).toBe(0.6);
  });

  it('suggest mode: one suggestion per state, no auto-apply; applying it continues the ladder', async () => {
    bridge = makeBridge({}, { noiseAdaptiveVad: { ...FAST_ADAPTIVE, mode: 'suggest' } });
    const session = await connectCall();
    const suggestions: VadSuggestionInfo[] = [];
    const adjusted: VadAdjustment[] = [];
    session.on('vad.suggestion', (info) => suggestions.push(info));
    session.on('vad.adjusted', (info) => adjusted.push(info));

    feed(noiseFrames(400));
    await waitFor(() => suggestions.length === 1, 2000, 'suggestion');
    expect(suggestions[0]!.autoApplicable).toBe(true); // policy: safe to auto-apply…
    expect(suggestions[0]!.willAutoApply).toBe(false); // …but suggest mode won't
    expect(updates()).toHaveLength(1); // nothing sent

    feed(noiseFrames(1000)); // latched: no suggestion spam while the app decides
    await delay(50);
    expect(suggestions).toHaveLength(1);

    await expect(session.updateVad(suggestions[0]!.suggested)).resolves.toBe(true);
    expect(vadOf(updates()[1]!)).toMatchObject({ threshold: 0.6, interrupt_response: false });

    feed(noiseFrames(800)); // rebase moved the effective base: next rung is 0.7
    await waitFor(() => suggestions.length === 2, 2000, 'next suggestion');
    expect(suggestions[1]!.suggested.threshold).toBe(0.7);
    expect(adjusted).toHaveLength(0); // suggest mode never auto-commits
    expect(updates()).toHaveLength(2); // only the app's own updateVad
  });

  it('manual rebase: after updateVad(0.8) escalation proposes 0.9, never 0.6', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const adjusted: VadAdjustment[] = [];
    session.on('vad.adjusted', (info) => adjusted.push(info));

    await expect(session.updateVad({ type: 'server', threshold: 0.8 })).resolves.toBe(true);
    feed(noiseFrames(800));
    await waitFor(() => adjusted.length === 1, 2000, 'escalation from 0.8');
    expect(adjusted[0]!.suggested.threshold).toBe(0.9);
    expect(updates().every((u) => vadOf(u)?.threshold !== 0.6)).toBe(true);
  });

  it('updateVad(null) disables adaptation; a later non-null call re-enables it', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const suggestions: VadSuggestionInfo[] = [];
    session.on('vad.suggestion', (info) => suggestions.push(info));

    await expect(session.updateVad(null)).resolves.toBe(true);
    expect(vadOf(updates()[1]!)).toBeNull(); // turn detection off on the wire

    feed(noiseFrames(1000));
    await delay(50);
    expect(suggestions).toHaveLength(0); // adaptation must never re-enable VAD

    await expect(session.updateVad({ type: 'server', threshold: 0.5 })).resolves.toBe(true);
    feed(noiseFrames(800));
    await waitFor(() => suggestions.length >= 1, 2000, 're-enabled escalation');
    expect(suggestions[0]!.suggested.threshold).toBe(0.6);
  });

  it('escalate-only: silence after a step never lowers the threshold', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const adjusted: VadAdjustment[] = [];
    session.on('vad.adjusted', (info) => adjusted.push(info));

    feed(noiseFrames(400));
    await waitFor(() => adjusted.length === 1, 2000, 'first adjustment');

    feed(noiseFrames(2000, 0)); // the noise stops entirely
    await delay(50);
    expect(updates()).toHaveLength(2); // nothing ever steps down
  });

  it('a committed override survives reconnect (buildProviderInit carries it)', async () => {
    bridge = makeBridge({}, { reconnect: FAST_RECONNECT });
    const session = await connectCall();
    const adjusted: VadAdjustment[] = [];
    session.on('vad.adjusted', (info) => adjusted.push(info));

    feed(noiseFrames(400));
    await waitFor(() => adjusted.length === 1, 2000, 'committed step');

    server.latest.drop(1011);
    await waitFor(() => server.connections.length === 2, 3000, 'reconnect connection');
    const handshake = await server.connections[1]!.waitForEvent('session.update');
    expect(vadOf(handshake)).toEqual({
      type: 'server_vad',
      threshold: 0.6,
      silence_duration_ms: 700,
      interrupt_response: false,
    });
  });

  it('meters frames the deafness guards drop (idle-line noise before the first agent turn)', async () => {
    bridge = makeBridge({}, { greeting: { mode: 'agent-initiates' } }); // first-turn deafness default ON
    const session = await connectCall();
    const adjusted: VadAdjustment[] = [];
    session.on('vad.adjusted', (info) => adjusted.push(info));

    feed(noiseFrames(400));
    await waitFor(() => adjusted.length === 1, 2000, 'escalation while deaf');
    // The provider heard nothing — the frames were dropped by deafness — yet
    // the meter saw them (the tap sits before the guards).
    expect(server.latest.appendedAudio).toHaveLength(0);
    expect(session).toBeDefined();
  });

  it('feature absent ⇒ unchanged call-runtime behavior (no events, no serialization, no extra updates)', async () => {
    await useManualAckServer();
    bridge = new TwilioRealtimeBridge({
      agent: new Agent({ name: 'Receptionist', instructions: 'You answer the phone briefly.' }),
      provider: openaiRealtime({ apiKey: 'test', baseUrl: server.url }),
      session: {
        greeting: { mode: 'user-initiates' },
        vad: { type: 'server', threshold: 0.5, silenceDurationMs: 700 },
        // noiseAdaptiveVad deliberately absent
      },
    });
    const session = await connectCallManualAck();
    const vadEvents: unknown[] = [];
    session.on('vad.suggestion', (info) => vadEvents.push(info));
    session.on('vad.adjusted', (info) => vadEvents.push(info));

    const frames = noiseFrames(1000);
    feed(frames);
    await waitFor(
      () => server.latest.appendedAudio.length === frames.length,
      2000,
      'audio forwarded verbatim',
    );
    expect(server.latest.appendedAudio).toEqual(frames); // byte-identical passthrough
    expect(vadEvents).toHaveLength(0);
    expect(updates()).toHaveLength(1); // only the connect handshake

    // Legacy fire-and-forget pinned: both updates hit the wire with ZERO acks granted.
    void session.updateInstructions('A');
    void session.updateInstructions('B');
    await waitFor(
      () => updates().some((u) => (u.session as any).instructions === 'B'),
      2000,
      'second unacked update on the wire',
    );
    expect(updates()).toHaveLength(3);
  });

  it('feature ON serializes updateInstructions alongside adaptive updates without loss', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const adjusted: VadAdjustment[] = [];
    session.on('vad.adjusted', (info) => adjusted.push(info));

    feed(noiseFrames(400));
    await waitFor(() => adjusted.length === 1, 2000, 'adaptive step');

    await session.updateInstructions('You are now the billing agent.');
    const instructionsUpdate = await server.latest.waitForEvent(
      (f) => f.type === 'session.update' && f.session.instructions === 'You are now the billing agent.',
    );
    // The serialized instructions update carries the escalated vad state along.
    expect(vadOf(instructionsUpdate).threshold).toBe(0.6);
  });
});
