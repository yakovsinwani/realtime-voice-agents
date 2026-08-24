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
    // Plumbing check only — opt out of first-turn deafness (default true).
    bridge = makeBridge({ session: { deafness: { ignoreUserAudioUntilFirstTurnDone: false } } });
    await connectCall();
    fake.sendSilence(60);
    await waitFor(() => server.latest.appendedAudio.length === 3, 2000, 'audio appended upstream');
  });

  it('first-turn deafness (default): caller audio is dropped until the greeting finishes playing', async () => {
    bridge = makeBridge();
    await connectCall();

    // The greeting is still generating/playing: caller frames must be dropped.
    fake.sendSilence(60);
    await delay(50);
    expect(server.latest.appendedAudio.length).toBe(0);

    server.latest.sendAudioResponse({
      responseId: 'greet',
      chunks: [mulawSilenceBase64(100), mulawSilenceBase64(100)],
    });
    await waitFor(() => fake.sentMediaPayloads.length === 2, 2000, 'greeting at Twilio');
    await waitFor(
      () => fake.outbound.filter((f) => f.event === 'mark').length === 2,
      2000,
      'first + final checkpoint marks',
    );
    fake.playAll();

    // Mark-confirmed playout of the first turn restores hearing.
    fake.sendSilence(60);
    await waitFor(() => server.latest.appendedAudio.length === 3, 2000, 'audio heard after first turn');
  });

  it('muteWhileAgentSpeaking drops caller audio during playback and restores it after', async () => {
    // First-turn deafness off so this proves the playback gate in isolation.
    bridge = makeBridge({
      session: {
        deafness: { ignoreUserAudioUntilFirstTurnDone: false, muteWhileAgentSpeaking: true },
      },
    });
    await connectCall();

    server.latest.sendAudioResponse({
      responseId: 'talk',
      chunks: [mulawSilenceBase64(200), mulawSilenceBase64(200)],
    });
    await waitFor(() => fake.sentMediaPayloads.length === 2, 2000, 'agent audio at Twilio');

    // The agent is audibly speaking: caller frames must be dropped, not queued.
    fake.sendSilence(60);
    await delay(50);
    expect(server.latest.appendedAudio.length).toBe(0);

    await waitFor(
      () => fake.outbound.filter((f) => f.event === 'mark').length === 2,
      2000,
      'first + final checkpoint marks',
    );
    fake.playAll();
    await waitFor(() => fake.queuedMs === 0, 2000, 'playback drained');

    // Playback finished: hearing is restored.
    fake.sendSilence(60);
    await waitFor(() => server.latest.appendedAudio.length === 3, 2000, 'audio heard after playback');
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

  it('allowed barge-in mid-generation: bridge sends response.cancel and drops straggler deltas', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const ended: string[] = [];
    session.on('agent.speech.ended', ({ responseId }) => ended.push(responseId));

    // Generation still in flight (no response.done yet) when the caller talks.
    server.latest.sendAudioResponse({
      responseId: 'gen',
      itemId: 'item_gen',
      chunks: [mulawSilenceBase64(200), mulawSilenceBase64(200)],
      complete: false,
    });
    await waitFor(() => fake.sentMediaPayloads.length === 2, 2000, 'audio at Twilio');
    fake.advancePlayback(200);
    server.latest.sendSpeechStarted();

    await waitFor(() => fake.clearCount === 1, 2000, 'clear frame');
    // The server no longer auto-cancels (interrupt_response: false) — the
    // bridge must do it itself.
    await server.latest.waitForEvent('response.cancel');
    await server.latest.waitForEvent('conversation.item.truncate');

    // A delta already in flight when we cancelled must not reach Twilio —
    // it would queue stale speech behind the clear.
    server.latest.send({
      type: 'response.output_audio.delta',
      response_id: 'gen',
      item_id: 'item_gen',
      delta: mulawSilenceBase64(200),
    });
    server.latest.send({ type: 'response.done', response: { id: 'gen', status: 'cancelled' } });
    await waitFor(() => ended.length === 1, 2000, 'response settled');
    expect(fake.sentMediaPayloads.length).toBe(2);
  });

  it('blocked barge-in: agent keeps talking, and the swallowed caller turn is answered after playback', async () => {
    bridge = makeBridge({
      session: {
        greeting: { mode: 'user-initiates' }, // keep response.create traffic to the continuity one
        interruptions: { enabled: true, guardDurationMs: 60_000 },
      },
    });
    const session = await connectCall();
    const blocked: string[] = [];
    session.on('interruption.blocked', ({ cause }) => blocked.push(cause));

    server.latest.sendAudioResponse({
      responseId: 'protected',
      chunks: [mulawSilenceBase64(300), mulawSilenceBase64(300)],
      complete: false,
    });
    await waitFor(() => fake.sentMediaPayloads.length === 2, 2000, 'audio at Twilio');
    fake.advancePlayback(100);

    // Caller talks through the guard: nothing is cancelled, nothing cleared.
    server.latest.sendSpeechStarted();
    await waitFor(() => blocked.length === 1, 2000, 'blocked event');
    server.latest.sendSpeechStopped();
    expect(fake.clearCount).toBe(0);
    expect(server.latest.eventsOfType('response.cancel').length).toBe(0);

    server.latest.send({ type: 'response.done', response: { id: 'protected', status: 'completed' } });
    await waitFor(
      () => fake.outbound.filter((f) => f.event === 'mark').length === 2,
      2000,
      'first + tail checkpoint marks',
    );
    expect(fake.sentMediaPayloads.length).toBe(2); // agent audio flowed untouched

    // Protected playback completes → the bridge answers the swallowed turn.
    fake.playAll();
    await server.latest.waitForEvent('response.create');
  });

  it('a server auto-response to a blocked turn does not disarm the first-response guard', async () => {
    bridge = makeBridge({
      session: {
        greeting: { mode: 'user-initiates' },
        interruptions: { enabled: true, guardDurationMs: 60_000, firstResponseOnly: true },
      },
    });
    const session = await connectCall();
    const blocked: string[] = [];
    session.on('interruption.blocked', ({ cause }) => blocked.push(cause));

    // The guarded response streams and starts playing.
    server.latest.sendAudioResponse({
      responseId: 'protected',
      chunks: [mulawSilenceBase64(400), mulawSilenceBase64(400)],
    });
    await waitFor(() => fake.sentMediaPayloads.length === 2, 2000, 'audio at Twilio');
    fake.advancePlayback(400); // first checkpoint echoes → guard clock starts

    // Caller mumbles: blocked. Their committed turn gets auto-answered by the
    // server while the protected audio is still playing.
    server.latest.sendSpeechStarted();
    await waitFor(() => blocked.length === 1, 2000, 'first block');
    server.latest.sendSpeechStopped();
    server.latest.sendAudioResponse({
      responseId: 'phantom',
      chunks: [mulawSilenceBase64(200)],
    });
    await waitFor(() => fake.sentMediaPayloads.length === 3, 2000, 'phantom audio queued');

    // Caller talks again mid-protected-playback: the phantom's responseStarted
    // must NOT have burned the firstResponseOnly guard.
    server.latest.sendSpeechStarted();
    await waitFor(() => blocked.length === 2, 2000, 'second block');
    expect(blocked).toEqual(['guard', 'guard']);
    expect(fake.clearCount).toBe(0);
  });

  it('fallback providers (no vadInterruptControl): barge-in clears but never sends response.cancel', async () => {
    bridge = makeBridge({
      provider: ({ logger }) =>
        new OpenAICompatibleProvider(
          {
            apiKey: 'test',
            model: 'grok-voice-latest',
            baseUrl: server.url,
            capabilityOverrides: { vadInterruptControl: false },
          },
          logger,
        ),
    });
    await connectCall();

    // Generation still in flight when the caller talks — on these providers
    // the SERVER already cancelled; the bridge must not race it.
    server.latest.sendAudioResponse({
      responseId: 'gen',
      itemId: 'item_gen',
      chunks: [mulawSilenceBase64(200), mulawSilenceBase64(200)],
      complete: false,
    });
    await waitFor(() => fake.sentMediaPayloads.length === 2, 2000, 'audio at Twilio');
    fake.advancePlayback(200);
    server.latest.sendSpeechStarted();

    await waitFor(() => fake.clearCount === 1, 2000, 'clear frame');
    expect(server.latest.eventsOfType('response.cancel').length).toBe(0);
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

  it('caller talking over the goodbye completes the hangup immediately (no watchdog wait)', async () => {
    bridge = makeBridge({ builtinTools: { finishCall: true } });
    const session = await connectCall();
    let endedReason = '';
    session.on('call.ended', ({ reason }) => (endedReason = reason));

    server.latest.sendToolCall({ name: 'finish_call', argumentsJson: '{"reason":"done"}' });
    await server.latest.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
    );
    server.latest.sendAudioResponse({ responseId: 'bye', chunks: [mulawSilenceBase64(400)] });
    await waitFor(() => fake.queuedMs > 0, 2000, 'goodbye audio at Twilio');

    // Caller hears a bit of the goodbye, then talks over it: the flushed
    // farewell will never confirm — the hangup must complete now, well
    // before the 7s watchdog.
    fake.advancePlayback(100);
    server.latest.sendSpeechStarted();
    await waitFor(() => session.state === 'ended', 2000, 'immediate hangup');
    expect(endedReason).toBe('agent-hangup');
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

  it('goodbye playing longer than markTimeoutMs is not truncated (echoes re-arm the watchdog)', async () => {
    bridge = makeBridge({
      builtinTools: { finishCall: true },
      session: { hangup: { markTimeoutMs: 400 } },
    });
    const session = await connectCall();
    let endedReason = '';
    session.on('call.ended', ({ reason }) => (endedReason = reason));
    let finishedMs = 0;
    session.on('playback.finished', (e) => (finishedMs = e.playedMs));

    server.latest.sendToolCall({ name: 'finish_call', argumentsJson: '{"reason":"done"}' });
    await server.latest.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
    );
    // A 5s goodbye in 500ms deltas — checkpoint marks land roughly every
    // second of audio, so playout keeps echoing proof of life.
    server.latest.sendAudioResponse({
      responseId: 'bye',
      chunks: Array.from({ length: 10 }, () => mulawSilenceBase64(500)),
      transcript: 'A long goodbye',
    });
    await waitFor(() => fake.queuedMs >= 5000, 2000, 'goodbye audio at Twilio');

    // Play out gradually across ~1.25s of wall clock — several times the
    // 400ms window. Each step echoes checkpoint marks; the pre-fix one-shot
    // watchdog would have force-hung-up mid-goodbye at +400ms.
    for (let step = 0; step < 5; step++) {
      expect(session.state).not.toBe('ended');
      fake.advancePlayback(1000);
      await delay(250);
    }
    await waitFor(() => session.state === 'ended', 2000, 'hangup after full playout');
    expect(endedReason).toBe('agent-hangup');
    expect(finishedMs).toBe(5000); // the goodbye played to the last millisecond
  });

  it('goodbye still generating when the window elapses is given more time (deltas re-arm)', async () => {
    bridge = makeBridge({
      builtinTools: { finishCall: true },
      session: { hangup: { markTimeoutMs: 250 } },
    });
    const session = await connectCall();
    let endedReason = '';
    session.on('call.ended', ({ reason }) => (endedReason = reason));

    server.latest.sendToolCall({ name: 'finish_call', argumentsJson: '{}' });
    await server.latest.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
    );
    // The model trickles the goodbye out over ~1.2s of wall clock — ~5 quiet
    // windows' worth — without any playout yet. Each delta is evidence.
    server.latest.send({ type: 'response.created', response: { id: 'bye' } });
    server.latest.send({
      type: 'response.output_item.added',
      response_id: 'bye',
      item: { id: 'item_bye', type: 'message' },
    });
    for (let i = 0; i < 8; i++) {
      expect(session.state).not.toBe('ended');
      server.latest.send({
        type: 'response.output_audio.delta',
        response_id: 'bye',
        item_id: 'item_bye',
        delta: mulawSilenceBase64(100),
      });
      await delay(150);
    }
    server.latest.send({ type: 'response.done', response: { id: 'bye', status: 'completed' } });

    await waitFor(() => fake.queuedMs >= 800, 2000, 'full goodbye at Twilio');
    fake.playAll();
    await waitFor(() => session.state === 'ended', 2000, 'hangup after playout');
    expect(endedReason).toBe('agent-hangup');
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
      session: {
        reconnect: { maxAttempts: 3, initialDelayMs: 20, maxDelayMs: 50, jitter: false },
        // Reconnect-buffering check — keep first-turn deafness out of the way.
        deafness: { ignoreUserAudioUntilFirstTurnDone: false },
      },
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
    expect(text).toContain('Receptionist: Sure, let me check.');
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
