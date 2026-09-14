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
import { DEFAULT_KEYPAD_INSTRUCTIONS } from '../dtmf/KeypadCollector.js';
import { pcm16ToMulaw } from '../audio/mulaw.js';
import { tool } from '../tools/tool.js';
import { geminiLive } from '../gemini.js';
import { FakeGeminiLive } from '../testing/FakeGeminiLive.js';
import { FakeGptLiveServer, mulawToneBase64 } from '../testing/FakeGptLiveServer.js';
import { FakeOpenAIServer } from '../testing/FakeOpenAIServer.js';
import { gptLive } from '../gpt-live.js';
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

  it('keypad: the same entry lands as a USER turn that triggers a response on every provider; the note reaches every system prompt', async () => {
    const server = await FakeOpenAIServer.start();
    const fakeGemini = new FakeGeminiLive();
    const session: Partial<SessionOptions> = { ...SESSION, keypad: {} };
    const openaiBridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: ({ logger }) =>
        new OpenAICompatibleProvider({ apiKey: 'k', model: 'gpt-realtime', baseUrl: server.url }, logger),
      session,
    });
    const geminiBridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: geminiLive({ connector: fakeGemini.connector, model: 'gemini-test' }),
      session,
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

    for (const fake of [fakeA, fakeB]) for (const key of '12#') fake.sendDtmf(key);

    const item = await server.latest.waitForEvent('conversation.item.create');
    expect(item.item.role).toBe('user');
    expect(item.item.content[0].text).toContain('[keypad] I typed on my phone keypad: 12');
    await server.latest.waitForEvent('response.create');
    expect(server.latest.eventsOfType('session.update')[0]!.session.instructions).toContain(DEFAULT_KEYPAD_INSTRUCTIONS);

    await waitFor(() => fakeGemini.latest.clientContents.length === 1, 2000, 'gemini client content');
    const content = fakeGemini.latest.clientContents[0]!;
    expect(content.turns[0]!.role).toBe('user');
    expect(content.turns[0]!.parts[0].text).toContain('[keypad] I typed on my phone keypad: 12');
    expect(content.turnComplete).toBe(true); // Gemini's "respond now"
    expect((fakeGemini.latest.params.config as any).systemInstruction).toContain(DEFAULT_KEYPAD_INSTRUCTIONS);
  });
});

describe('provider parity: GPT-Live (full-duplex, model-owned turn-taking)', () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
  });

  const connect = async (server: FakeGptLiveServer, session: Partial<SessionOptions>, extra: Record<string, unknown> = {}) => {
    const bridge = new TwilioRealtimeBridge({
      agent: AGENT,
      // playoutLeadMs: 0 pins the raw wire behavior; the lead has its own test below.
      provider: gptLive({ apiKey: 'k', baseUrl: server.url, playoutLeadMs: 0, delegation: { instructions: 'Backend prompt.' } }),
      session,
      ...extra,
    });
    cleanup.push(async () => {
      await bridge.close();
      await server.close();
    });
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active');
    return { bridge, fake, session: bridge.getSession(fake.callSid)! };
  };

  it('GPT-Live: instructions and voice land on the session, tools on the backend delegation; VAD has no analog and is dropped (documented)', async () => {
    const server = await FakeGptLiveServer.start();
    await connect(server, SESSION);
    const start = server.latest.startFrame!.session;
    expect(start.instructions).toContain('Shared instructions.');
    expect(start.audio).toEqual({ format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } });
    expect(start.delegation.responses.instructions).toBe('Backend prompt.');
    expect(start.delegation.responses.tools.map((t: any) => t.name)).toContain('shared_tool');
    // The same SESSION.vad that lands as turn_detection on OpenAI/xAI has no
    // wire shape here: the model owns turn-taking (strict schema — an unknown
    // field would reject the session).
    expect(JSON.stringify(start)).not.toMatch(/turn_detection|interrupt_response|threshold/);
  });

  it('GPT-Live fallback (documented): the interruption guard is observe-only — interrupt() sends no clear and nothing is cancelled', async () => {
    const server = await FakeGptLiveServer.start();
    const { fake, session } = await connect(server, SESSION);
    const interrupted: unknown[] = [];
    session.on('playback.interrupted', (e) => interrupted.push(e));
    // The agent is mid-utterance (speech with no closing silence yet).
    server.latest.send({ type: 'session.output_audio.delta', delta: mulawToneBase64(100) });
    await waitFor(() => fake.sentMediaPayloads.length > 0, 2000, 'agent audio at Twilio');
    session.interrupt();
    await delay(30);
    expect(fake.outbound.some((f) => f.event === 'clear')).toBe(false);
    expect(server.latest.received.some((f) => /cancel|truncate/.test(f.type))).toBe(false);
    expect(interrupted).toEqual([]);
  });

  it('GPT-Live: tool results are delivered immediately while the agent is still speaking (decoupled backend)', async () => {
    const server = await FakeGptLiveServer.start();
    const { fake, session } = await connect(server, SESSION);
    const finished: unknown[] = [];
    session.on('playback.finished', (e) => finished.push(e));
    server.latest.send({ type: 'session.output_audio.delta', delta: mulawToneBase64(100) });
    await waitFor(() => fake.sentMediaPayloads.length > 0, 2000, 'agent audio at Twilio');
    server.latest.sendFunctionCall({ name: 'shared_tool', argumentsJson: '{"q":"x"}' });
    const item = await server.latest.waitForEvent('response.item.create');
    expect(JSON.parse(item.item.output)).toEqual({ ok: true });
    await server.latest.waitForEvent('response.create');
    // …and nothing had finished playing: the default afterPlayback queue was bypassed.
    expect(finished).toEqual([]);
  });

  it('GPT-Live: the greeting is a commentary append and a keypad entry is a thinking append', async () => {
    const server = await FakeGptLiveServer.start();
    const { fake } = await connect(server, {
      greeting: { mode: 'agent-initiates', instructions: 'Open with: "Hello, you reached Acme."' },
      keypad: { maxDigits: 2 },
    });
    await waitFor(() => server.latest.appends.length >= 1, 2000, 'greeting append');
    expect(server.latest.appends[0]).toEqual({
      type: 'session.commentary.append',
      content: 'Open with: "Hello, you reached Acme."',
      delegation_id: null,
    });
    fake.sendDtmf('1');
    fake.sendDtmf('2');
    await waitFor(() => server.latest.appends.length >= 2, 2000, 'keypad append');
    const keypad = server.latest.appends[1]!;
    expect(keypad.type).toBe('session.thinking.append');
    expect(keypad.content).toContain('[keypad]');
    expect(keypad.content).toContain('12');
    // Typing did not clear Twilio either (model-owned turn-taking).
    expect(fake.outbound.some((f) => f.event === 'clear')).toBe(false);
  });

  it('GPT-Live: deafness substitutes silence for caller audio (the session clock must keep ticking)', async () => {
    const server = await FakeGptLiveServer.start();
    // Explicit: the default is off on a full-duplex provider (see the next test).
    const { fake } = await connect(server, {
      greeting: { mode: 'agent-initiates' },
      deafness: { ignoreUserAudioUntilFirstTurnDone: true },
    });
    const tone = mulawToneBase64(20);
    fake.sendMedia(tone);
    fake.sendMedia(tone);
    await waitFor(() => server.latest.appendedAudio.length === 2, 2000, 'silence frames');
    for (const payload of server.latest.appendedAudio) {
      const bytes = Buffer.from(payload, 'base64');
      expect(bytes).toHaveLength(160);
      expect(bytes.every((b) => b === 0xff)).toBe(true);
    }
    // First turn plays out → the line opens up and caller audio passes untouched.
    server.latest.sendSpeech({ chunks: [mulawToneBase64(100)], silenceMs: 1000 });
    await waitFor(() => fake.sentMediaPayloads.length > 0, 2000, 'agent audio');
    fake.playAll();
    await delay(50);
    fake.sendMedia(tone);
    await waitFor(() => server.latest.appendedAudio.length === 3, 2000, 'caller frame');
    expect(server.latest.appendedAudio[2]).toBe(tone);
  });

  it('GPT-Live: duration ticks are a running total, backend tokens are summed', async () => {
    const server = await FakeGptLiveServer.start();
    const { session } = await connect(server, SESSION);
    server.latest.sendUsage(14);
    server.latest.sendUsage(29);
    server.latest.sendBackendCompleted({ usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
    await waitFor(() => session.usage.responses === 1, 2000, 'backend usage');
    expect(session.usage.audioSeconds).toBe(29);
    expect(session.usage.inputTokens).toBe(100);
    expect(session.usage.totalTokens).toBe(110);
  });

  it('GPT-Live: finish_call is a backend tool; the call ends after the goodbye plays out and the session is closed', async () => {
    const server = await FakeGptLiveServer.start();
    const { fake, session } = await connect(server, SESSION, { builtinTools: { finishCall: true } });
    const ended: string[] = [];
    session.on('call.ended', (e) => ended.push(e.reason));
    server.latest.sendFunctionCall({ name: 'finish_call', argumentsJson: '{"reason":"done"}' });
    const result = await server.latest.waitForEvent('response.item.create');
    expect(JSON.parse(result.item.output).status).toBe('ending_call');
    // The backend's goodbye is spoken by the voice model…
    server.latest.sendSpeech({ chunks: [mulawToneBase64(200)], silenceMs: 1000 });
    await waitFor(() => fake.sentMediaPayloads.length > 0, 2000, 'goodbye audio');
    fake.playAll();
    // …and only once it has played does the call complete, closing the Live session.
    await waitFor(() => ended.length === 1, 5000, 'call ended');
    expect(ended[0]).toBe('agent-hangup');
    await waitFor(() => server.latest.eventsOfType('session.close').length === 1, 2000, 'session.close');
  });

  it('GPT-Live: a goodbye split at a sentence pause does not end the call between its sentences', async () => {
    const server = await FakeGptLiveServer.start();
    const { fake, session } = await connect(server, SESSION, { builtinTools: { finishCall: true } });
    const ended: string[] = [];
    session.on('call.ended', (e) => ended.push(e.reason));
    server.latest.sendFunctionCall({ name: 'finish_call' });
    await server.latest.waitForEvent('response.item.create');
    // Sentence one plays out and closes the gate (the stream carried a pause).
    server.latest.sendSpeech({ chunks: [mulawToneBase64(200)], silenceMs: 1000 });
    await waitFor(() => fake.sentMediaPayloads.length > 0, 2000, 'sentence one');
    fake.playAll();
    await delay(400); // inside the grace window: still on the call
    expect(session.state).not.toBe('ended');
    // Sentence two arrives — the grace is cancelled and its playout gates completion again.
    const before = fake.sentMediaPayloads.length;
    server.latest.sendSpeech({ chunks: [mulawToneBase64(200)], silenceMs: 1000 });
    await waitFor(() => fake.sentMediaPayloads.length > before, 2000, 'sentence two');
    await delay(1300);
    expect(ended).toEqual([]); // sentence two has not played yet — no completion despite the elapsed grace
    fake.playAll();
    await waitFor(() => ended.length === 1, 5000, 'call ended after sentence two');
    expect(ended[0]).toBe('agent-hangup');
  });

  it('GPT-Live: first-turn deafness is off by default — the caller is heard from the first frame (the model owns talk-over)', async () => {
    const server = await FakeGptLiveServer.start();
    const { fake } = await connect(server, { greeting: { mode: 'agent-initiates' } });
    const tone = mulawToneBase64(20);
    fake.sendMedia(tone);
    await waitFor(() => server.latest.appendedAudio.length === 1, 2000, 'caller frame');
    expect(server.latest.appendedAudio[0]).toBe(tone);
  });

  it('GPT-Live: a session that drops mid-utterance does not wedge playback — finish_call completes via the sentence grace, not the watchdog', async () => {
    const server = await FakeGptLiveServer.start();
    const { fake, session } = await connect(server, SESSION, { builtinTools: { finishCall: true } });
    const ended: string[] = [];
    session.on('call.ended', (e) => ended.push(e.reason));
    // The voice is mid-utterance (gate open, audio at Twilio) when the socket dies…
    server.latest.send({ type: 'session.output_audio.delta', delta: mulawToneBase64(100) });
    await waitFor(() => fake.sentMediaPayloads.length > 0, 2000, 'agent audio at Twilio');
    server.latest.drop();
    // …and the bridge reopens a fresh session. That utterance never ends and its
    // tail mark never comes: unless it is abandoned, isPlaybackActive() stays true.
    await waitFor(() => server.connections.length === 2, 3000, 'reconnected');
    await server.latest.waitForEvent('session.start');
    server.latest.sendFunctionCall({ name: 'finish_call' });
    await server.latest.waitForEvent('response.item.create');
    const mediaBefore = fake.sentMediaPayloads.length;
    server.latest.sendSpeech({ chunks: [mulawToneBase64(200)], silenceMs: 1000 });
    await waitFor(() => fake.sentMediaPayloads.length > mediaBefore, 2000, 'goodbye audio');
    fake.playAll();
    const t0 = Date.now();
    await waitFor(() => ended.length === 1, 5000, 'call ended');
    expect(ended[0]).toBe('agent-hangup');
    expect(Date.now() - t0).toBeLessThan(4000); // the 7 s watchdog was not what ended it
  });

  it('GPT-Live: the default playout lead reaches Twilio as one burst, so the line keeps a cushion against jitter', async () => {
    const server = await FakeGptLiveServer.start();
    const bridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: gptLive({ apiKey: 'k', baseUrl: server.url }), // default playoutLeadMs (200)
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
    const tone = mulawToneBase64(100);
    server.latest.send({ type: 'session.output_audio.delta', delta: tone });
    await delay(80);
    expect(fake.sentMediaPayloads).toEqual([]); // 100 ms held: nothing at Twilio yet
    server.latest.send({ type: 'session.output_audio.delta', delta: tone });
    await waitFor(() => fake.sentMediaPayloads.length === 2, 2000, 'lead burst'); // 200 ms → both at once
    server.latest.send({ type: 'session.output_audio.delta', delta: tone });
    await waitFor(() => fake.sentMediaPayloads.length === 3, 2000, 'streamed through');
  });

  it('GPT-Live: a gate close-and-reopen inside one delta does not leave playback wedged — finish_call still completes via the grace', async () => {
    const server = await FakeGptLiveServer.start();
    const bridge = new TwilioRealtimeBridge({
      agent: AGENT,
      provider: gptLive({ apiKey: 'k', baseUrl: server.url, playoutLeadMs: 0, speechGate: { quietMs: 100 } }),
      session: SESSION,
      builtinTools: { finishCall: true },
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
    const started: string[] = [];
    const finishedUtterances: string[] = [];
    const ended: string[] = [];
    session.on('agent.speech.started', (e) => started.push(e.responseId));
    session.on('agent.speech.ended', (e) => finishedUtterances.push(e.responseId));
    session.on('call.ended', (e) => ended.push(e.reason));
    // Speech, ≥ quietMs of quiet, speech — all in one delta (field: utt_9 was left open forever).
    const composite = Buffer.concat([
      Buffer.from(mulawToneBase64(60), 'base64'),
      Buffer.alloc(120 * 8, 0xff),
      Buffer.from(mulawToneBase64(60), 'base64'),
    ]).toString('base64');
    server.latest.send({ type: 'session.output_audio.delta', delta: composite });
    await waitFor(() => started.length === 2, 2000, 'two utterances');
    // The second utterance closes on the stall fallback; only then does its tail mark exist to play out.
    await waitFor(() => finishedUtterances.length === 2, 2000, 'both utterances ended');
    fake.playAll();
    // Now hang up: with a wedged tracker the grace never arms and only the 7 s watchdog ends the call.
    server.latest.sendFunctionCall({ name: 'finish_call' });
    await server.latest.waitForEvent('response.item.create');
    server.latest.sendSpeech({ chunks: [mulawToneBase64(200)], silenceMs: 1000 });
    await waitFor(() => finishedUtterances.length === 3, 2000, 'goodbye ended');
    fake.playAll();
    const t0 = Date.now();
    await waitFor(() => ended.length === 1, 5000, 'call ended');
    expect(ended[0]).toBe('agent-hangup');
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});
