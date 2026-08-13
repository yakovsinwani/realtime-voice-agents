/**
 * Provider parity (sinwan pattern): one SessionOptions surface, N providers.
 * The same knob must land in each provider's native config — and where a
 * provider cannot honor it, the documented fallback is asserted instead of
 * left implicit.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../agents/Agent.js';
import { pcm16ToMulaw } from '../audio/mulaw.js';
import { tool } from '../tools/tool.js';
import { geminiLive } from '../gemini.js';
import { FakeGeminiLive } from '../testing/FakeGeminiLive.js';
import { FakeOpenAIServer } from '../testing/FakeOpenAIServer.js';
import { FakeTwilioMediaStream } from '../testing/FakeTwilioMediaStream.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible/OpenAICompatibleProvider.js';
import { buildXaiSessionUpdate, xaiRealtime } from '../xai.js';
import { TwilioRealtimeBridge } from './TwilioRealtimeBridge.js';
import type { SessionOptions } from './config.js';
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

const AGENT = new Agent({
  name: 'Parity Agent',
  instructions: 'Shared instructions.',
  voice: 'marin',
  tools: [
    tool({
      name: 'shared_tool',
      description: 'Shared tool.',
      parameters: z.object({ q: z.string() }),
      execute: async () => ({ ok: true }),
    }),
  ],
});

const SESSION: Partial<SessionOptions> = {
  greeting: { mode: 'user-initiates' },
  vad: { type: 'server', silenceDurationMs: 700, prefixPaddingMs: 300, threshold: 0.6 },
};

/** 20 ms base64 μ-law frames of a 440 Hz tone at ≈ −30 dBFS (above the −45 trigger). */
function noiseFrames(ms: number): string[] {
  const frames: string[] = [];
  for (let start = 0; start < ms; start += 20) {
    const pcm = new Int16Array(160);
    for (let i = 0; i < 160; i++) {
      pcm[i] = Math.round(1465 * Math.sin((2 * Math.PI * 440 * (start * 8 + i)) / 8000));
    }
    frames.push(Buffer.from(pcm16ToMulaw(pcm)).toString('base64'));
  }
  return frames;
}

/** Fast, deterministic noise-adaptation clocks (ms of audio; 20 ms frames). */
const FAST_ADAPTIVE = { windowMs: 200, sustainMs: 100, cooldownMs: 300, maxSteps: 2 };

describe('provider parity: one config surface', () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
  });

  it('OpenAI: instructions, voice, tools, VAD land in session.audio', async () => {
    const server = await FakeOpenAIServer.start();
    const bridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: ({ logger }) =>
        new OpenAICompatibleProvider({ apiKey: 'k', model: 'gpt-realtime', baseUrl: server.url }, logger),
      session: SESSION,
    });
    cleanup.push(async () => {
      await bridge.close();
      await server.close();
    });
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active');

    const update = (await server.latest.waitForEvent('session.update')).session as any;
    expect(update.instructions).toContain('Shared instructions.');
    expect(update.audio.output.voice).toBe('marin');
    expect(update.tools.map((t: any) => t.name)).toContain('shared_tool');
    expect(update.audio.input.turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.6,
      silence_duration_ms: 700,
      prefix_padding_ms: 300,
      // vadInterruptControl: the bridge owns barge-in, so the server must not
      // auto-cancel the active response on speech onset.
      interrupt_response: false,
    });
  });

  it('OpenAI: an explicit vad.interruptResponse overrides bridge ownership', async () => {
    const server = await FakeOpenAIServer.start();
    const bridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: ({ logger }) =>
        new OpenAICompatibleProvider({ apiKey: 'k', model: 'gpt-realtime', baseUrl: server.url }, logger),
      session: { ...SESSION, vad: { type: 'server', interruptResponse: true, createResponse: false } },
    });
    cleanup.push(async () => {
      await bridge.close();
      await server.close();
    });
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active');

    const update = (await server.latest.waitForEvent('session.update')).session as any;
    expect(update.audio.input.turn_detection).toEqual({
      type: 'server_vad',
      interrupt_response: true,
      create_response: false,
    });
  });

  it('Gemini: same config lands in live config; threshold has no analog and is dropped (documented)', async () => {
    const fakeGemini = new FakeGeminiLive();
    const bridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: geminiLive({ connector: fakeGemini.connector, model: 'gemini-test' }),
      session: SESSION,
    });
    cleanup.push(async () => bridge.close());
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active');

    const config = fakeGemini.latest.params.config as any;
    expect(config.systemInstruction).toContain('Shared instructions.');
    expect(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('marin');
    expect(config.tools[0].functionDeclarations.map((t: any) => t.name)).toContain('shared_tool');
    const vad = config.realtimeInputConfig.automaticActivityDetection;
    expect(vad.silenceDurationMs).toBe(700);
    expect(vad.prefixPaddingMs).toBe(300);
    // Documented fallback: Gemini VAD has sensitivities, not a numeric threshold.
    expect(vad.threshold).toBeUndefined();
  });

  it('xAI: same normalized VAD maps to root turn_detection; voice at root', () => {
    const payload = buildXaiSessionUpdate({
      instructions: 'Shared instructions.',
      voice: 'marin',
      vad: SESSION.vad,
      tools: [{ name: 'shared_tool', description: 'Shared tool.', parameters: { type: 'object' } }],
    }) as any;
    expect(payload.session.instructions).toContain('Shared instructions.');
    expect(payload.session.voice).toBe('marin');
    expect(payload.session.turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.6,
      silence_duration_ms: 700,
      prefix_padding_ms: 300,
    });
    expect(payload.session.tools.map((t: any) => t.name)).toContain('shared_tool');
  });

  it('xAI fallback (documented): no vadInterruptControl — interrupt_response is never sent', async () => {
    // interrupt_response is undocumented for Grok Voice, so the capability is
    // off: server-side auto-interrupt stays on and the interruption guard
    // protects only already-buffered Twilio audio.
    const server = await FakeOpenAIServer.start();
    const bridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: ({ logger }) =>
        new OpenAICompatibleProvider(
          {
            apiKey: 'k',
            model: 'grok-voice-latest',
            baseUrl: server.url,
            buildSession: buildXaiSessionUpdate,
            capabilityOverrides: { truncate: false, vadInterruptControl: false },
          },
          logger,
        ),
      session: SESSION,
    });
    cleanup.push(async () => {
      await bridge.close();
      await server.close();
    });
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active');

    const update = (await server.latest.waitForEvent('session.update')).session as any;
    expect(update.turn_detection.interrupt_response).toBeUndefined();
  });

  it('xAI noise adaptation escalates from the documented 0.85 default to 0.9 (never an invented 0.5)', async () => {
    const server = await FakeOpenAIServer.start();
    const bridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: xaiRealtime({ apiKey: 'k', baseUrl: server.url }),
      session: {
        greeting: { mode: 'user-initiates' },
        // Deliberately NO explicit threshold: the baseline must come from the
        // xAI factory's vadTuning profile (0.85, range 0.1–0.9) — an assumed
        // OpenAI-style 0.5 would LOWER xAI's threshold instead of raising it.
        vad: { type: 'server', silenceDurationMs: 700 },
        noiseAdaptiveVad: FAST_ADAPTIVE,
      },
    });
    cleanup.push(async () => {
      await bridge.close();
      await server.close();
    });
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active');
    const session = bridge.getSession(fake.callSid)!;
    const adjusted: VadAdjustment[] = [];
    session.on('vad.adjusted', (info) => adjusted.push(info));

    for (const frame of noiseFrames(400)) fake.sendMedia(frame);
    await waitFor(() => adjusted.length === 1, 2000, 'xAI adjustment');
    const update = server.latest.eventsOfType('session.update')[1]! as any;
    // xAI shape: turn_detection at the session root; 0.85 + 0.1 clamps to the
    // profile's 0.9 max. No interrupt_response (vadInterruptControl is off).
    expect(update.session.turn_detection.threshold).toBe(0.9);
    expect(update.session.turn_detection.interrupt_response).toBeUndefined();

    // 0.85 → 0.9 was the only useful rung: more noise must never step again.
    for (const frame of noiseFrames(800)) fake.sendMedia(frame);
    await delay(60);
    expect(server.latest.eventsOfType('session.update')).toHaveLength(2);
  });

  it('Gemini fallback (documented): noise adaptation is suggestion-only — no mid-session update exists', async () => {
    const fakeGemini = new FakeGeminiLive();
    const bridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: geminiLive({ connector: fakeGemini.connector, model: 'gemini-test' }),
      session: {
        greeting: { mode: 'user-initiates' },
        vad: { type: 'server', threshold: 0.6, silenceDurationMs: 700 },
        noiseAdaptiveVad: FAST_ADAPTIVE,
      },
    });
    cleanup.push(async () => bridge.close());
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active');
    const session = bridge.getSession(fake.callSid)!;
    const suggestions: VadSuggestionInfo[] = [];
    const adjusted: VadAdjustment[] = [];
    session.on('vad.suggestion', (info) => suggestions.push(info));
    session.on('vad.adjusted', (info) => adjusted.push(info));

    for (const frame of noiseFrames(600)) fake.sendMedia(frame);
    await waitFor(() => suggestions.length === 1, 2000, 'gemini suggestion');
    // Auto mode, but capabilities.sessionUpdate is false: suggestion only,
    // carrying the Gemini-native analog (startSensitivity) for the app.
    expect(suggestions[0]!.willAutoApply).toBe(false);
    expect(suggestions[0]!.suggested.startSensitivity).toBe('low');

    for (const frame of noiseFrames(1000)) fake.sendMedia(frame);
    await delay(60);
    expect(suggestions).toHaveLength(1); // latched — one suggestion per effective state
    expect(adjusted).toHaveLength(0);
    expect(fakeGemini.sessions).toHaveLength(1); // live config untouched, no reconnect
  });

  it('semantic VAD fallback (documented): eagerness is an end-of-turn latency control — never auto-applied', async () => {
    const server = await FakeOpenAIServer.start();
    const bridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: ({ logger }) =>
        new OpenAICompatibleProvider({ apiKey: 'k', model: 'gpt-realtime', baseUrl: server.url }, logger),
      session: {
        greeting: { mode: 'user-initiates' },
        vad: { type: 'semantic', eagerness: 'medium' },
        noiseAdaptiveVad: FAST_ADAPTIVE,
      },
    });
    cleanup.push(async () => {
      await bridge.close();
      await server.close();
    });
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active');
    const session = bridge.getSession(fake.callSid)!;
    const suggestions: VadSuggestionInfo[] = [];
    session.on('vad.suggestion', (info) => suggestions.push(info));

    for (const frame of noiseFrames(600)) fake.sendMedia(frame);
    await waitFor(() => suggestions.length === 1, 2000, 'semantic suggestion');
    expect(suggestions[0]!.autoApplicable).toBe(false); // policy, not a runtime gate
    expect(suggestions[0]!.willAutoApply).toBe(false);
    expect(suggestions[0]!.suggested).toMatchObject({ type: 'semantic', eagerness: 'low' });

    await delay(60);
    // Even in auto mode the session config was never touched.
    expect(server.latest.eventsOfType('session.update')).toHaveLength(1);
  });

  it('greeting user-initiates: neither provider gets an unsolicited response trigger', async () => {
    const server = await FakeOpenAIServer.start();
    const fakeGemini = new FakeGeminiLive();
    const openaiBridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: ({ logger }) =>
        new OpenAICompatibleProvider({ apiKey: 'k', model: 'gpt-realtime', baseUrl: server.url }, logger),
      session: { greeting: { mode: 'user-initiates' } },
    });
    const geminiBridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: geminiLive({ connector: fakeGemini.connector, model: 'gemini-test' }),
      session: { greeting: { mode: 'user-initiates' } },
    });
    cleanup.push(async () => {
      await openaiBridge.close();
      await geminiBridge.close();
      await server.close();
    });

    const fakeA = new FakeTwilioMediaStream();
    openaiBridge.handleConnection(fakeA);
    fakeA.connect();
    const fakeB = new FakeTwilioMediaStream();
    geminiBridge.handleConnection(fakeB);
    fakeB.connect();
    await waitFor(() => openaiBridge.getSession(fakeA.callSid)?.state === 'active');
    await waitFor(() => geminiBridge.getSession(fakeB.callSid)?.state === 'active');
    await delay(60);

    expect(server.latest.eventsOfType('response.create')).toHaveLength(0);
    expect(fakeGemini.latest.clientContents).toHaveLength(0);
  });
});
