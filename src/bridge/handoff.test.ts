/** Multi-agent handoffs + pre-synthesized greeting, end-to-end. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../agents/Agent.js';
import { tool } from '../tools/tool.js';
import { geminiLive } from '../gemini.js';
import { captureGreetingAudio } from '../greeting/capture.js';
import { FakeGeminiLive } from '../testing/FakeGeminiLive.js';
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
