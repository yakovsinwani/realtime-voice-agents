/** Multi-agent handoffs + pre-synthesized greeting, end-to-end. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../agents/Agent.js';
import { tool } from '../tools/tool.js';
import { geminiLive } from '../gemini.js';
import { captureGreetingAudio } from '../greeting/capture.js';
import { FakeGeminiLive } from '../testing/FakeGeminiLive.js';
import { FakeGptLiveServer, mulawToneBase64 } from '../testing/FakeGptLiveServer.js';
import { gptLive } from '../gpt-live.js';
import { FakeOpenAIServer } from '../testing/FakeOpenAIServer.js';
import { FakeTwilioMediaStream, mulawSilenceBase64 } from '../testing/FakeTwilioMediaStream.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible/OpenAICompatibleProvider.js';
import { TwilioRealtimeBridge } from './TwilioRealtimeBridge.js';
import type { BridgeConfig } from './config.js';
import type { CallSession } from './CallSession.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function makeAgents() {
  const billing = new Agent({
    name: 'Billing Department',
    id: 'billing',
    instructions: 'You handle invoices and payments.',
    handoffDescription: 'Transfer for invoice, payment, or refund questions.',
    tools: [
      tool({
        name: 'lookup_invoice',
        description: 'Find an invoice',
        parameters: z.object({ invoiceId: z.string() }),
        execute: async ({ invoiceId }) => ({ invoiceId, amount: 99 }),
      }),
    ],
  });
  const receptionist = new Agent({
    name: 'Receptionist',
    id: 'receptionist',
    instructions: 'Greet and route the caller.',
    handoffs: [billing],
  });
  // Billing can send the caller back.
  (billing.handoffs as Agent[]).push(receptionist);
  return { receptionist, billing };
}

describe('multi-agent handoffs (OpenAI path: session.update)', () => {
  let server: FakeOpenAIServer;
  let bridge: TwilioRealtimeBridge;
  let fake: FakeTwilioMediaStream;

  const makeBridge = (overrides: Partial<BridgeConfig> = {}) => {
    const { receptionist } = makeAgents();
    return new TwilioRealtimeBridge({
      agent: receptionist,
      provider: ({ logger }) =>
        new OpenAICompatibleProvider(
          { apiKey: 'test', model: 'gpt-realtime', baseUrl: server.url },
          logger,
        ),
      session: { greeting: { mode: 'user-initiates' } },
      ...overrides,
    });
  };

  const connectCall = async (): Promise<CallSession> => {
    fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active session');
    return bridge.getSession(fake.callSid)!;
  };

  beforeEach(async () => {
    server = await FakeOpenAIServer.start();
  });

  afterEach(async () => {
    await bridge?.close();
    await server.close();
  });

  it('declares transfer tools from the handoff graph', async () => {
    bridge = makeBridge();
    await connectCall();
    const update = await server.latest.waitForEvent('session.update');
    const toolNames = (update.session as any).tools.map((t: any) => t.name);
    expect(toolNames).toContain('transfer_to_billing');
    expect((update.session as any).tools.find((t: any) => t.name === 'transfer_to_billing').description)
      .toContain('invoice');
  });

  it('tool-initiated handoff: result settles the call, session.update swaps agent, response continues', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const handoffs: Array<{ from: string; to: string; reason?: string }> = [];
    session.on('agent.handoff', ({ from, to, reason }) => handoffs.push({ from: from.id, to: to.id, reason }));

    server.latest.sendToolCall({
      name: 'transfer_to_billing',
      argumentsJson: '{"reason":"invoice question"}',
    });

    const output = await server.latest.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
    );
    expect(JSON.parse(output.item.output)).toEqual({
      status: 'transferring_conversation',
      to: 'Billing Department',
    });

    const update = await server.latest.waitForEvent(
      (f) => f.type === 'session.update' && f.session.instructions?.includes('invoices and payments'),
    );
    const updatedTools = (update.session as any).tools.map((t: any) => t.name);
    expect(updatedTools).toContain('lookup_invoice');
    expect(updatedTools).toContain('transfer_to_receptionist');
    expect(updatedTools).not.toContain('transfer_to_billing');

    const continuation = await server.latest.waitForEvent(
      (f) => f.type === 'response.create' && f.response?.instructions?.includes('Billing Department'),
    );
    expect(continuation.response.instructions).toContain('invoice question');

    expect(session.activeAgent.id).toBe('billing');
    expect(handoffs).toEqual([{ from: 'receptionist', to: 'billing', reason: 'invoice question' }]);

    // The new agent's own tools now work.
    server.latest.sendToolCall({ name: 'lookup_invoice', argumentsJson: '{"invoiceId":"INV-1"}' });
    const invoice = await server.latest.waitForEvent(
      (f) =>
        f.type === 'conversation.item.create' &&
        f.item?.type === 'function_call_output' &&
        f.item.output.includes('INV-1'),
    );
    expect(JSON.parse(invoice.item.output)).toEqual({ invoiceId: 'INV-1', amount: 99 });
  });

  it('refuses a second transfer until the caller speaks, then allows it', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const handoffs: string[] = [];
    const blocked: Array<{ from: string; to: string; cause: string }> = [];
    session.on('agent.handoff', ({ from, to }) => handoffs.push(`${from.id}->${to.id}`));
    session.on('agent.handoff.blocked', ({ from, to, cause }) =>
      blocked.push({ from: from.id, to: to.id, cause }),
    );

    server.latest.sendUserTranscript('I have a question about invoice 12');
    server.latest.sendToolCall({ name: 'transfer_to_billing', argumentsJson: '{"reason":"invoice"}' });
    await waitFor(() => session.activeAgent.id === 'billing', 2000, 'handoff to billing');

    // Billing bounces the caller straight back without hearing a word — the
    // exact move that produced 14 transfers in 67 seconds in the field.
    server.latest.sendToolCall({
      name: 'transfer_to_receptionist',
      argumentsJson: '{"reason":"not my department"}',
    });
    const refusal = await server.latest.waitForEvent(
      (f) =>
        f.type === 'conversation.item.create' &&
        f.item?.type === 'function_call_output' &&
        f.item.output.includes('transfer_rejected'),
    );
    // The refusal reaches the model, or it just calls the tool again.
    expect(JSON.parse(refusal.item.output).message).toContain('caller has not spoken');
    expect(session.activeAgent.id).toBe('billing');
    expect(blocked).toEqual([{ from: 'billing', to: 'receptionist', cause: 'no-caller-turn' }]);
    expect(handoffs).toEqual(['receptionist->billing']);

    // A caller turn unlocks the very same transfer.
    server.latest.sendUserTranscript('Sorry, I actually called about something else');
    server.latest.sendToolCall({ name: 'transfer_to_receptionist', argumentsJson: '{}' });
    await waitFor(() => session.activeAgent.id === 'receptionist', 2000, 'transfer after caller turn');
    expect(handoffs).toEqual(['receptionist->billing', 'billing->receptionist']);
    expect(blocked).toHaveLength(1);
  });

  it('programmatic handoffTo bypasses the lock but arms it for the incoming agent', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const blocked: string[] = [];
    session.on('agent.handoff.blocked', ({ to }) => blocked.push(to.id));

    // Back-to-back host-driven transfers: no caller turn, both go through.
    await session.handoffTo('billing');
    await session.handoffTo('receptionist');
    expect(session.activeAgent.id).toBe('receptionist');
    expect(blocked).toEqual([]);

    // The agent the host installed is still locked.
    server.latest.sendToolCall({ name: 'transfer_to_billing', argumentsJson: '{}' });
    await waitFor(() => blocked.length === 1, 2000, 'model transfer blocked');
    expect(session.activeAgent.id).toBe('receptionist');
  });

  it('programmatic handoffTo works and records handoff history in the snapshot', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    await session.handoffTo('billing');
    expect(session.activeAgent.id).toBe('billing');
    await server.latest.waitForEvent(
      (f) => f.type === 'session.update' && f.session.instructions?.includes('invoices'),
    );
  });

  it('rejects handoff to agents outside the graph', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    await expect(session.handoffTo('nonexistent')).rejects.toThrow('unknown agent');
  });
});

describe('multi-agent handoffs (Gemini path: reconnect + context carry)', () => {
  it('reopens the session with new instructions, no resumption handle, and re-injected history', async () => {
    const fakeGemini = new FakeGeminiLive();
    const { receptionist } = makeAgents();
    const bridge = new TwilioRealtimeBridge({
      agent: receptionist,
      provider: geminiLive({ connector: fakeGemini.connector, model: 'gemini-test' }),
      session: { greeting: { mode: 'user-initiates' } },
    });
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active');
    const session = bridge.getSession(fake.callSid)!;

    // Some history + a stored resumption handle that must NOT survive handoff.
    fakeGemini.latest.sendResumptionUpdate('old-handle');
    fakeGemini.latest.sendInputTranscription('I want to pay my invoice');
    fakeGemini.latest.serverMessage({ serverContent: { turnComplete: true } });
    await waitFor(() => session.transcript.length === 1, 2000, 'transcript');

    await session.handoffTo('billing');

    expect(fakeGemini.sessions).toHaveLength(2);
    const second = fakeGemini.latest;
    expect((second.params.config as any).systemInstruction).toContain('invoices and payments');
    // Fresh session: config changed, resumption pinned to the old config is dropped.
    expect((second.params.config as any).sessionResumption).toEqual({});
    const injected = second.clientContents.map((c) => JSON.stringify(c));
    expect(injected.some((c) => c.includes('I want to pay my invoice'))).toBe(true);
    expect(injected.some((c) => c.includes('Billing Department'))).toBe(true);
    expect(session.activeAgent.id).toBe('billing');

    await bridge.close();
  });

  it('replays the transcript with per-agent attribution and the transfer that happened', async () => {
    const fakeGemini = new FakeGeminiLive();
    const { receptionist } = makeAgents();
    const bridge = new TwilioRealtimeBridge({
      agent: receptionist,
      provider: geminiLive({ connector: fakeGemini.connector, model: 'gemini-test' }),
      session: { greeting: { mode: 'user-initiates' } },
    });
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active');
    const session = bridge.getSession(fake.callSid)!;

    fakeGemini.latest.sendInputTranscription('I need a refund on invoice 12');
    fakeGemini.latest.sendAudioTurn({ pcm24kBase64Chunks: [], transcript: 'Let me get billing.' });
    await waitFor(() => session.transcript.length === 2, 2000, 'transcript');

    // Tool-initiated so the transfer carries a reason into the replay.
    fakeGemini.latest.sendToolCall({
      name: 'transfer_to_billing',
      args: { reason: 'refund request' },
    });
    await waitFor(() => session.activeAgent.id === 'billing', 2000, 'handoff');

    const replay = fakeGemini.latest.clientContents
      .flatMap((content) => content.turns)
      .flatMap((turn) => (turn.parts ?? []).map((part: { text?: string }) => part.text ?? ''))
      .join('\n');
    // The receiving agent sees WHO said what…
    expect(replay).toContain('Caller: I need a refund on invoice 12');
    expect(replay).toContain('Receptionist: Let me get billing.');
    // …and that the routing already happened, so it does not route again.
    expect(replay).toContain('[transfer] Receptionist -> Billing Department (reason: refund request)');
    expect(replay).not.toContain('Agent: Let me get billing.');

    await bridge.close();
  });
});

describe('multi-agent handoffs (GPT-Live path: reconnect + history seeded at start)', () => {
  it('reopens with the new agent and seeds the attributed transcript via session.input instead of re-injecting text', async () => {
    const server = await FakeGptLiveServer.start();
    const { receptionist } = makeAgents();
    const bridge = new TwilioRealtimeBridge({
      agent: receptionist,
      provider: gptLive({ apiKey: 'k', baseUrl: server.url }),
      session: { greeting: { mode: 'user-initiates' } },
    });
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active');
    const session = bridge.getSession(fake.callSid)!;

    server.latest.sendInputTranscript('I need a refund on invoice 12', { startMs: 1000, endMs: 2000 });
    server.latest.sendSpeech({ chunks: [mulawToneBase64(100)], transcript: 'Let me get billing.', startMs: 4000 });
    await waitFor(() => session.transcript.length === 2, 3000, 'transcript');
    await waitFor(() => fake.sentMediaPayloads.length > 0, 2000, 'agent audio at Twilio');
    fake.playAll(); // the sentence has played out: a transfer may reopen the session at once

    server.latest.sendFunctionCall({ name: 'transfer_to_billing', argumentsJson: '{"reason":"refund request"}' });
    await waitFor(() => session.activeAgent.id === 'billing', 3000, 'handoff');
    await waitFor(() => server.connections.length === 2, 2000, 'second session');
    const second = server.latest;
    await second.waitForEvent('session.start');
    const start = second.startFrame!.session;
    expect(start.instructions).toContain('invoices and payments');
    const input: Array<{ role: string; content: Array<{ text: string }> }> = start.input;
    const lines = input.map((m) => `${m.role}: ${m.content[0]!.text}`);
    // The receiving agent sees who said what and that the routing already happened…
    expect(lines[0]).toMatch(/^developer: Context: this phone call reconnected/);
    expect(lines).toContain('user: I need a refund on invoice 12');
    expect(lines).toContain('assistant: Receptionist: Let me get billing.');
    expect(lines).toContain('developer: [transfer] Receptionist -> Billing Department (reason: refund request)');
    // …seeded at start, not appended after: the only append is the continuation.
    await waitFor(() => second.appends.length >= 1, 2000, 'continuation');
    expect(second.appends).toHaveLength(1);
    expect(second.appends[0]!.type).toBe('session.commentary.append');
    expect(second.appends[0]!.content).toContain('You are now Billing Department');

    await bridge.close();
    await server.close();
  });

  it('holds a transfer that lands mid-utterance until the sentence has played out, and the handoff hold covers the reopen', async () => {
    const server = await FakeGptLiveServer.start();
    const { receptionist } = makeAgents();
    const bridge = new TwilioRealtimeBridge({
      agent: receptionist,
      provider: gptLive({ apiKey: 'k', baseUrl: server.url }),
      session: { greeting: { mode: 'user-initiates' }, handoffHold: { spec: 'ringing', startDelayMs: 0 } },
    });
    const fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active');
    const session = bridge.getSession(fake.callSid)!;
    const holds: string[] = [];
    const utterancesEnded: string[] = [];
    session.on('background_audio.started', (e) => holds.push(e.preset ?? ''));
    session.on('agent.speech.ended', (e) => utterancesEnded.push(e.responseId));

    // The voice is mid-sentence ("one moment, transferring you…") when the
    // backend's transfer lands: the tool call settles, the session does not.
    server.latest.send({ type: 'session.output_audio.delta', delta: mulawToneBase64(300) });
    await waitFor(() => fake.sentMediaPayloads.length > 0, 2000, 'agent audio at Twilio');
    server.latest.sendFunctionCall({ name: 'transfer_to_billing' });
    await server.latest.waitForEvent('response.item.create');
    await delay(300);
    expect(server.connections).toHaveLength(1);
    expect(session.activeAgent.id).toBe('receptionist');
    expect(holds).toEqual([]);

    // The sentence ends and plays out; one sentence gap later the handoff reopens.
    server.latest.sendSilence(1000);
    await waitFor(() => utterancesEnded.length === 1, 2000, 'utterance end');
    fake.playAll();
    await waitFor(() => server.connections.length === 2, 4000, 'reopened');
    await waitFor(() => session.activeAgent.id === 'billing', 2000, 'handoff');
    // Nothing was in flight when the hold started, so it survived to cover the gap.
    expect(holds).toEqual(['ringing']);

    await bridge.close();
    await server.close();
  });
});

describe('pre-synthesized greeting', () => {
  let server: FakeOpenAIServer;
  let bridge: TwilioRealtimeBridge;
  let fake: FakeTwilioMediaStream;

  beforeEach(async () => {
    server = await FakeOpenAIServer.start();
  });

  afterEach(async () => {
    await bridge?.close();
    await server.close();
  });

  it('burst-writes the greeting, suppresses re-greeting, and gates caller audio until playout', async () => {
    const greetingAudio = Buffer.alloc(8000, 0x55); // 1s of μ-law
    bridge = new TwilioRealtimeBridge({
      agent: new Agent({ name: 'A', instructions: 'Base instructions.' }),
      provider: ({ logger }) =>
        new OpenAICompatibleProvider(
          { apiKey: 'test', model: 'gpt-realtime', baseUrl: server.url },
          logger,
        ),
      session: {
        greeting: {
          mode: 'agent-initiates',
          preSynthesized: { audio: greetingAudio, text: 'Hi, thanks for calling Acme!' },
        },
      },
    });
    fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active');
    const session = bridge.getSession(fake.callSid)!;

    // The whole greeting went out in one burst (3200-byte chunks) + a mark.
    const mediaBytes = fake.sentMediaPayloads.reduce((a, p) => a + Buffer.from(p, 'base64').length, 0);
    expect(mediaBytes).toBe(8000);
    expect(fake.outbound.filter((f) => f.event === 'mark').length).toBe(1);

    // Layer 1: instructions carry the no-re-greet reinforcement.
    const update = await server.latest.waitForEvent('session.update');
    expect(update.session.instructions).toContain('Do not greet again');
    // Layer 2: the greeting text is seeded as an assistant turn.
    const seed = await server.latest.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.role === 'assistant',
    );
    expect(seed.item.content[0].text).toBe('Hi, thanks for calling Acme!');
    // Layer 3: no auto response.create fired.
    await delay(50);
    expect(server.latest.eventsOfType('response.create')).toHaveLength(0);

    // Caller audio is dropped while the greeting is still playing…
    fake.sendSilence(40);
    await delay(50);
    expect(server.latest.appendedAudio).toHaveLength(0);

    // …and flows once Twilio confirms playout via the mark echo.
    const playbackEvents: string[] = [];
    session.on('playback.finished', ({ responseId }) => playbackEvents.push(responseId));
    fake.playAll();
    await waitFor(() => playbackEvents.includes('pregreeting'), 2000, 'pregreeting playback');
    fake.sendSilence(40);
    await waitFor(() => server.latest.appendedAudio.length === 2, 2000, 'audio flowing');

    // The transcript starts with the pre-played greeting.
    expect(session.transcript[0]).toMatchObject({ role: 'agent', text: 'Hi, thanks for calling Acme!' });
  });

  it('captureGreetingAudio records μ-law from a throwaway realtime session', async () => {
    const capturePromise = captureGreetingAudio({
      apiKey: 'test',
      baseUrl: server.url,
      voice: 'marin',
      text: 'Welcome to Acme.',
    });
    const connection = await server.waitForConnection();
    await connection.waitForEvent('response.create');
    connection.sendAudioResponse({
      responseId: 'cap',
      chunks: [mulawSilenceBase64(100), mulawSilenceBase64(60)],
    });
    const captured = await capturePromise;
    expect(captured.text).toBe('Welcome to Acme.');
    expect(captured.audio.length).toBe(1280); // 160ms of μ-law
    expect(captured.durationMs).toBe(160);
  });
});
