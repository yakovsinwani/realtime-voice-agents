/**
 * End-to-end scenarios: FakeTwilioMediaStream (the caller) ⇄ TwilioRealtimeBridge
 * ⇄ OpenAICompatibleProvider ⇄ FakeOpenAIServer (the model). Real WebSockets on
 * the provider side, deterministic playout on the Twilio side.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../agents/Agent.js';
import { tool } from '../tools/tool.js';
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

describe('bridge end-to-end (FakeTwilio ⇄ bridge ⇄ FakeOpenAI)', () => {
  let server: FakeOpenAIServer;
  let bridge: TwilioRealtimeBridge;
  let fake: FakeTwilioMediaStream;

  const makeBridge = (overrides: Partial<BridgeConfig> = {}) =>
    new TwilioRealtimeBridge({
      agent: new Agent({
        name: 'Receptionist',
        instructions: 'You answer the phone briefly.',
        voice: 'marin',
      }),
      provider: ({ logger }) =>
        new OpenAICompatibleProvider(
          { apiKey: 'test', model: 'gpt-realtime', baseUrl: server.url },
          logger,
        ),
      ...overrides,
    });

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

  it('runs the happy path: handshake, greeting, audio out, mark-confirmed playback events', async () => {
    bridge = makeBridge();
    const session = await connectCall();

    const events: string[] = [];
    session.on('playback.started', ({ responseId }) => events.push(`pb-start:${responseId}`));
    session.on('playback.finished', ({ responseId, playedMs }) =>
      events.push(`pb-finish:${responseId}:${playedMs}`),
    );
    session.on('transcript.agent', (entry) => events.push(`transcript:${entry.text}`));

    // Inbound call → the agent greets without waiting (response.create sent).
    await server.latest.waitForEvent('response.create');

    // The model streams a 300ms greeting in three 100ms chunks.
    server.latest.sendAudioResponse({
      responseId: 'greet',
      chunks: [mulawSilenceBase64(100), mulawSilenceBase64(100), mulawSilenceBase64(100)],
      transcript: 'Hi! How can I help?',
    });

    await waitFor(() => fake.sentMediaPayloads.length === 3, 2000, 'media forwarded to Twilio');
    // Checkpoint marks: one after the first chunk, one final tail once
    // response.done lands (300ms total is under the ~1s periodic interval).
    await waitFor(
      () => fake.outbound.filter((f) => f.event === 'mark').length === 2,
      2000,
      'first + final checkpoint marks',
    );

    fake.playAll();
    await waitFor(() => events.some((e) => e.startsWith('pb-finish')), 2000, 'playback finished');
    expect(events).toContain('pb-start:greet');
    expect(events).toContain('pb-finish:greet:300');
    expect(events).toContain('transcript:Hi! How can I help?');
  });

  it('interleaves checkpoint marks at ~1s intervals on long responses (not per delta)', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const finishes: number[] = [];
    session.on('playback.finished', ({ playedMs }) => finishes.push(playedMs));

    // 2.5s of audio in 25 × 100ms deltas.
    server.latest.sendAudioResponse({
      responseId: 'long',
      chunks: Array.from({ length: 25 }, () => mulawSilenceBase64(100)),
    });
    await waitFor(() => fake.sentMediaPayloads.length === 25, 2000, 'all media forwarded');
    // first chunk (100ms) + checkpoints at 1100ms / 2100ms + final tail (2500ms).
    await waitFor(
      () => fake.outbound.filter((f) => f.event === 'mark').length === 4,
      2000,
      'checkpoint marks only',
    );

    fake.playAll();
    await waitFor(() => finishes.length === 1, 2000, 'playback finished');
    expect(finishes[0]).toBe(2500); // final tail keeps playedMs exact
  });

  it('forwards caller audio to the provider', async () => {
    bridge = makeBridge();
    await connectCall();
    fake.sendSilence(60);
    await waitFor(() => server.latest.appendedAudio.length === 3, 2000, 'audio appended upstream');
  });

  it('handles barge-in: clear sent, truncate carries the played ms, events emitted', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const interruptions: number[] = [];
    session.on('playback.interrupted', ({ playedMs }) => interruptions.push(playedMs));

    server.latest.sendAudioResponse({
      responseId: 'long',
      itemId: 'item_long',
      chunks: [mulawSilenceBase64(200), mulawSilenceBase64(200), mulawSilenceBase64(200)],
    });
    await waitFor(() => fake.sentMediaPayloads.length === 3, 2000, 'audio queued at Twilio');

    // Caller hears the first 200ms chunk, then starts talking.
    fake.advancePlayback(200);
    server.latest.sendSpeechStarted();

    await waitFor(() => fake.clearCount === 1, 2000, 'clear frame');
    const truncate = await server.latest.waitForEvent('conversation.item.truncate');
    expect(truncate.item_id).toBe('item_long');
    expect(truncate.audio_end_ms).toBeGreaterThanOrEqual(200);
    expect(truncate.audio_end_ms).toBeLessThan(400);
    expect(interruptions.length).toBe(1);
  });

  it('blocks barge-in inside the guard window and emits interruption.blocked', async () => {
    bridge = makeBridge({ session: { interruptions: { enabled: true, guardDurationMs: 60_000 } } });
    const session = await connectCall();
    const blocked: string[] = [];
    session.on('interruption.blocked', ({ cause }) => blocked.push(cause));

    server.latest.sendAudioResponse({
      responseId: 'guarded',
      chunks: [mulawSilenceBase64(500)],
    });
    await waitFor(() => fake.sentMediaPayloads.length === 1, 2000, 'audio at Twilio');
    fake.advancePlayback(100);
    server.latest.sendSpeechStarted();
    await waitFor(() => blocked.length === 1, 2000, 'blocked event');
    expect(blocked).toEqual(['guard']);
    expect(fake.clearCount).toBe(0);
  });

  it('runs a sync tool and returns the result to the model', async () => {
    const lookup = tool({
      name: 'lookup_order',
      description: 'Lookup an order',
      parameters: z.object({ orderId: z.string() }),
      execute: async ({ orderId }, ctx) => {
        ctx.context.set('lastOrder', orderId);
        return { orderId, status: 'shipped' };
      },
    });
    bridge = makeBridge({
      agent: new Agent({ name: 'Support', instructions: 'Help.', tools: [lookup] }),
    });
    const session = await connectCall();
    const toolEvents: string[] = [];
    session.on('tool.started', (i) => toolEvents.push(`start:${i.toolName}`));
    session.on('tool.completed', (i) => toolEvents.push(`done:${i.toolName}`));

    server.latest.sendToolCall({ name: 'lookup_order', argumentsJson: '{"orderId":"A7"}' });

    const output = await server.latest.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
    );
    expect(JSON.parse(output.item.output)).toEqual({ orderId: 'A7', status: 'shipped' });
    await server.latest.waitForEvent('response.create');
    expect(toolEvents).toEqual(['start:lookup_order', 'done:lookup_order']);
    expect(session.context.get('lastOrder')).toBe('A7');
  });

  it('returns a validation error to the model for bad tool arguments', async () => {
    const strict = tool({
      name: 'strict_tool',
      description: 'strict',
      parameters: z.object({ amount: z.number() }),
      execute: async () => ({ ok: true }),
    });
    bridge = makeBridge({
      agent: new Agent({ name: 'S', instructions: 'x', tools: [strict] }),
    });
    await connectCall();
    server.latest.sendToolCall({ name: 'strict_tool', argumentsJson: '{"amount":"seven"}' });
    const output = await server.latest.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
    );
    expect(JSON.parse(output.item.output).error).toBe('validation_failed');
  });

  it('queues tool results while agent audio is playing, flushes after playback', async () => {
    const slow = tool({
      name: 'check_thing',
      description: 'check',
      parameters: z.object({}),
      execute: async () => ({ checked: true }),
    });
    bridge = makeBridge({
      agent: new Agent({ name: 'S', instructions: 'x', tools: [slow] }),
    });
    await connectCall();

    // Agent is mid-utterance (audio queued at Twilio, not yet played out).
    server.latest.sendAudioResponse({
      responseId: 'talk',
      chunks: [mulawSilenceBase64(400)],
    });
    await waitFor(() => fake.sentMediaPayloads.length === 1, 2000, 'audio at Twilio');

    server.latest.sendToolCall({ name: 'check_thing', argumentsJson: '{}' });
    await delay(80);
    // Result must NOT have been sent yet — playback is still active.
    expect(
      server.latest.received.filter(
        (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
      ),
    ).toHaveLength(0);

    fake.playAll();
    const output = await server.latest.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
    );
    expect(JSON.parse(output.item.output)).toEqual({ checked: true });
  });

  it('flushes multiple queued tool results with a single response.create', async () => {
    const mk = (name: string) =>
      tool({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => ({ ran: name }),
      });
    bridge = makeBridge({
      agent: new Agent({ name: 'S', instructions: 'x', tools: [mk('tool_a'), mk('tool_b')] }),
    });
    const session = await connectCall();
    let completed = 0;
    session.on('tool.completed', () => completed++);

    // Agent mid-utterance: both results must queue behind the playback.
    server.latest.sendAudioResponse({
      responseId: 'talk',
      chunks: [mulawSilenceBase64(400)],
    });
    await waitFor(() => fake.sentMediaPayloads.length === 1, 2000, 'audio at Twilio');
    server.latest.sendToolCall({ name: 'tool_a', argumentsJson: '{}' });
    server.latest.sendToolCall({ name: 'tool_b', argumentsJson: '{}' });
    await waitFor(() => completed === 2, 2000, 'both tools completed');
    const createsBefore = server.latest.eventsOfType('response.create').length;

    fake.playAll();
    await waitFor(
      () =>
        server.latest.received.filter(
          (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
        ).length === 2,
      2000,
      'both results flushed',
    );
    await delay(80); // a (buggy) second create would arrive in this window
    // N results, one response: back-to-back creates would trip the GA
    // active-response rejection mid-call.
    expect(server.latest.eventsOfType('response.create')).toHaveLength(createsBefore + 1);
  });

  it('survives a fatal provider error when the host attached no error listener', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    // Deliberately no session.on('error'): an unhandled 'error' emit must not
    // throw (Node would take the whole host process down otherwise).
    server.latest.sendError({ type: 'server_error', code: 'internal_error', message: 'boom' });
    await delay(60);
    expect(session.state).toBe('active');
  });

  it('finish_call builtin: goodbye plays fully, then the call ends', async () => {
    bridge = makeBridge({ builtinTools: { finishCall: true } });
    const session = await connectCall();
    let endedReason = '';
    session.on('call.ended', ({ reason }) => (endedReason = reason));

    server.latest.sendToolCall({ name: 'finish_call', argumentsJson: '{"reason":"done"}' });
    const output = await server.latest.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
    );
    expect(JSON.parse(output.item.output).status).toBe('ending_call');

    // The model speaks its goodbye.
    server.latest.sendAudioResponse({
      responseId: 'bye',
      chunks: [mulawSilenceBase64(150)],
      transcript: 'Goodbye!',
    });
    await waitFor(() => fake.queuedMs > 0, 2000, 'goodbye audio at Twilio');
    expect(session.state).not.toBe('ended'); // waiting for the goodbye to play

    fake.playAll();
    await waitFor(() => session.state === 'ended', 3000, 'session ended');
    expect(endedReason).toBe('agent-hangup');
    expect(fake.wasClosedByBridge).toBe(true);
  });

  it('hangup watchdog fires when the final mark echo never arrives', async () => {
    bridge = makeBridge({
      builtinTools: { finishCall: true },
      session: { hangup: { markTimeoutMs: 300 } },
    });
    const session = await connectCall();

    server.latest.sendToolCall({ name: 'finish_call', argumentsJson: '{}' });
    server.latest.sendAudioResponse({ responseId: 'bye', chunks: [mulawSilenceBase64(100)] });
    // Never advance fake playback: the mark echo never comes.
    await waitFor(() => session.state === 'ended', 3000, 'watchdog teardown');
  });

  it('tears down on caller hangup (stop frame)', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    let endedReason = '';
    session.on('call.ended', ({ reason }) => (endedReason = reason));
    fake.stop();
    fake.disconnect();
    await waitFor(() => session.state === 'ended', 2000, 'teardown');
    expect(endedReason).toBe('caller-hangup');
  });

  it('reconnects after a provider drop and re-injects the transcript', async () => {
    bridge = makeBridge({
      session: { reconnect: { maxAttempts: 3, initialDelayMs: 20, maxDelayMs: 50, jitter: false } },
    });
    const session = await connectCall();
    const reconnectEvents: string[] = [];
    session.on('provider.reconnecting', ({ attempt }) => reconnectEvents.push(`try:${attempt}`));
    session.on('provider.reconnected', () => reconnectEvents.push('ok'));

    // Build some history first.
    server.latest.sendUserTranscript('I need help with my invoice');
    server.latest.sendAudioResponse({
      responseId: 'r1',
      chunks: [mulawSilenceBase64(50)],
      transcript: 'Sure, let me check.',
    });
    fake.playAll();
    await waitFor(() => session.transcript.length === 2, 2000, 'transcript recorded');

    const firstConnection = server.latest;
    firstConnection.drop(1011);

    await waitFor(() => server.connections.length === 2, 3000, 'second provider connection');
    const second = server.latest;
    await second.waitForEvent('session.update');
    const history = await second.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.role === 'system',
    );
    const text = history.item.content[0].text as string;
    expect(text).toContain('Caller: I need help with my invoice');
    expect(text).toContain('Agent: Sure, let me check.');
    await waitFor(() => reconnectEvents.includes('ok'), 2000, 'reconnected event');

    // Audio arriving during the gap was buffered and flushed upstream.
    fake.sendSilence(40);
    await waitFor(() => second.appendedAudio.length >= 2, 2000, 'audio flowing after reconnect');
  });

  it('rejects a second stream for the same call', async () => {
    bridge = makeBridge();
    await connectCall();
    const rejected: string[] = [];
    bridge.on('connection.rejected', ({ reason }) => rejected.push(reason));
    const dupe = new FakeTwilioMediaStream({ callSid: fake.callSid });
    bridge.handleConnection(dupe);
    dupe.connect();
    await waitFor(() => rejected.includes('duplicate-call'), 2000, 'duplicate rejection');
  });

  it('validateConnection can reject unauthorized streams', async () => {
    bridge = makeBridge({
      validateConnection: (start) => start.start.customParameters?.token === 'secret',
    });
    const rejected: string[] = [];
    bridge.on('connection.rejected', ({ reason }) => rejected.push(reason));
    fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect({ customParameters: { token: 'wrong' } });
    await waitFor(() => rejected.includes('unauthorized'), 2000, 'unauthorized rejection');
    expect(bridge.getSession(fake.callSid)).toBeUndefined();
  });

  it('outbound greeting waits for notifyAnswered', async () => {
    bridge = makeBridge();
    fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect({ customParameters: { direction: 'outbound' } });
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active');

    await delay(60);
    expect(server.latest.eventsOfType('response.create')).toHaveLength(0);

    bridge.notifyAnswered(fake.callSid);
    await server.latest.waitForEvent('response.create');
  });
});
