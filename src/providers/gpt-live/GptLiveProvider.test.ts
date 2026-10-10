/** GptLiveProvider against FakeGptLiveServer (real WebSocket). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeGptLiveServer, mulawSilenceDeltas, mulawToneBase64 } from '../../testing/FakeGptLiveServer.js';
import type { ProviderUsage } from '../base/events.js';
import { GptLiveProvider, splitForAppend } from './GptLiveProvider.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('GptLiveProvider', () => {
  let server: FakeGptLiveServer;
  let provider: GptLiveProvider;

  const makeProvider = (overrides: Partial<ConstructorParameters<typeof GptLiveProvider>[0]> = {}) =>
    // playoutLeadMs: 0 pins the raw wire behavior; the lead has its own tests below.
    new GptLiveProvider({ apiKey: 'sk-test', model: 'gpt-live-1', voice: 'marin', baseUrl: server.url, playoutLeadMs: 0, ...overrides });

  beforeEach(async () => {
    server = await FakeGptLiveServer.start();
  });

  afterEach(async () => {
    await provider?.close();
    await server.close();
  });

  it('connects with a bearer key, starts a μ-law session, and reports the expiry', async () => {
    provider = makeProvider({ delegation: { model: 'gpt-5.6-terra', instructions: 'Backend.' } });
    await provider.connect({ instructions: 'Voice.', tools: [{ name: 't', parameters: { type: 'object' } }] });
    expect(provider.isConnected).toBe(true);
    expect(server.latest.upgradeHeaders.authorization).toBe('Bearer sk-test');
    const start = server.latest.startFrame!;
    expect(start.session.audio.format).toEqual({ type: 'audio/pcmu', rate: 8000 });
    expect(start.session.delegation.responses.tools[0].name).toBe('t');
    expect(provider.sessionId).toMatch(/^live_fake_/);
    expect(provider.expiresAt).toBeGreaterThan(Date.now() / 1000 + 7000);
    expect(provider.capabilities).toMatchObject({ turnTaking: 'model', startupHistory: true, decoupledBackend: true, truncate: false, sessionUpdate: false });
  });

  it('rejects connect when session.start is refused (strict schema errors carry the param)', async () => {
    await server.close();
    server = await FakeGptLiveServer.start({ rejectStart: { code: 'unknown_parameter', message: "Unknown parameter: 'session.foo'.", param: 'session.foo' } });
    provider = makeProvider();
    await expect(provider.connect({ instructions: 'x' })).rejects.toThrow(/unknown_parameter/);
    expect(provider.isConnected).toBe(false);
  });

  it('forwards caller audio as session.input_audio.append', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    provider.sendAudio('AAAA');
    await server.latest.waitForEvent('session.input_audio.append');
    expect(server.latest.appendedAudio).toEqual(['AAAA']);
  });

  it('synthesizes utterances from the continuous stream: silence is not speech, speech opens, quiet closes', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const events: string[] = [];
    const audio: string[] = [];
    provider.on('responseStarted', ({ responseId }) => events.push(`start:${responseId}`));
    provider.on('responseDone', ({ responseId }) => events.push(`done:${responseId}`));
    provider.on('audio', (d) => audio.push(d.responseId));

    server.latest.sendSilence(2000); // idle stream: nothing
    await delay(50);
    expect(events).toEqual([]);
    expect(audio).toEqual([]);

    server.latest.sendSpeech({ chunks: [mulawToneBase64(100), mulawToneBase64(100)], silenceMs: 1000 });
    await waitFor(() => events.length === 2, 2000, 'utterance');
    expect(events).toEqual(['start:live_utt_1', 'done:live_utt_1']);
    // Both speech deltas and the trailing quiet (up to the close) went out under the utterance id;
    // idle silence after the close did not.
    expect(audio.length).toBeGreaterThanOrEqual(2);
    expect(new Set(audio)).toEqual(new Set(['live_utt_1']));
    const forwarded = audio.length;
    server.latest.sendSilence(1000);
    await delay(50);
    expect(audio.length).toBe(forwarded);

    server.latest.sendSpeech({ chunks: [mulawToneBase64(100)] });
    await waitFor(() => events.length === 4, 2000, 'second utterance');
    expect(events.slice(2)).toEqual(['start:live_utt_2', 'done:live_utt_2']);
  });

  it('closes a stalled utterance on the wall-clock fallback', async () => {
    provider = makeProvider({ speechGate: { quietMs: 100 } });
    await provider.connect({ instructions: 'x' });
    const events: string[] = [];
    provider.on('responseDone', ({ responseId }) => events.push(responseId));
    server.latest.send({ type: 'session.output_audio.delta', delta: mulawToneBase64(100) });
    await waitFor(() => events.length === 1, 2000, 'stall close'); // no more deltas: 100 + 500 ms stall window
  });

  it('a close and a reopen inside one delta end the old utterance first and start a new one (no utterance left open)', async () => {
    provider = makeProvider({ speechGate: { quietMs: 100 } });
    await provider.connect({ instructions: 'x' });
    const events: string[] = [];
    const audio: string[] = [];
    provider.on('responseStarted', ({ responseId }) => events.push(`start:${responseId}`));
    provider.on('responseDone', ({ responseId }) => events.push(`done:${responseId}`));
    provider.on('audio', (d) => audio.push(d.responseId));
    // One delta: 60 ms speech, 120 ms quiet (≥ quietMs → close), 60 ms speech (→ open).
    const composite = Buffer.concat([
      Buffer.from(mulawToneBase64(60), 'base64'),
      ...mulawSilenceDeltas(120).map((d) => Buffer.from(d, 'base64')),
      Buffer.from(mulawToneBase64(60), 'base64'),
    ]).toString('base64');
    server.latest.send({ type: 'session.output_audio.delta', delta: composite });
    await waitFor(() => events.length === 4, 2000, 'both utterances closed'); // utt_2 closes on the stall fallback
    expect(events).toEqual(['start:live_utt_1', 'done:live_utt_1', 'start:live_utt_2', 'done:live_utt_2']);
    expect(audio).toEqual(['live_utt_2']); // the delta carries the onset: it belongs to the new utterance
  });

  it('playout lead: holds the first playoutLeadMs of an utterance (pre-roll included), then streams through', async () => {
    provider = makeProvider({ playoutLeadMs: 300 });
    await provider.connect({ instructions: 'x' });
    const audio: string[] = [];
    provider.on('audio', (d) => audio.push(d.base64Mulaw));
    const idle = mulawSilenceDeltas(100)[0]!;
    const tone = mulawToneBase64(100);

    server.latest.send({ type: 'session.output_audio.delta', delta: idle }); // idle → pre-roll
    server.latest.send({ type: 'session.output_audio.delta', delta: tone }); // onset: 100 pre-roll + 100 = 200 < 300
    await delay(60);
    expect(audio).toEqual([]);
    server.latest.send({ type: 'session.output_audio.delta', delta: tone }); // 300 ≥ 300 → flush, in order
    await waitFor(() => audio.length === 3, 2000, 'lead flushed');
    expect(audio).toEqual([idle, tone, tone]);
    server.latest.send({ type: 'session.output_audio.delta', delta: tone }); // past the lead: straight through
    await waitFor(() => audio.length === 4, 2000, 'streamed through');
  });

  it('playout lead: an utterance shorter than the lead is flushed whole at its close, before responseDone', async () => {
    provider = makeProvider({ playoutLeadMs: 5000 });
    await provider.connect({ instructions: 'x' });
    const order: string[] = [];
    provider.on('audio', () => order.push('audio'));
    provider.on('responseDone', () => order.push('done'));
    server.latest.sendSpeech({ chunks: [mulawToneBase64(100)], silenceMs: 1000 }); // 100 speech + 800 quiet closes the gate
    await waitFor(() => order.includes('done'), 2000, 'utterance closed');
    expect(order.indexOf('done')).toBe(order.length - 1);
    expect(order.filter((e) => e === 'audio').length).toBeGreaterThanOrEqual(2); // the speech and the quiet up to the close
  });

  it('groups transcript fragments into turns; agent turns carry the utterance id', async () => {
    provider = makeProvider({ transcriptGapMs: 300 });
    await provider.connect({ instructions: 'x' });
    const user: string[] = [];
    const agent: Array<{ responseId: string; text: string }> = [];
    const deltas: string[] = [];
    provider.on('userTranscript', ({ text }) => user.push(text));
    provider.on('agentTranscript', (e) => agent.push(e));
    provider.on('agentTranscriptDelta', ({ delta }) => deltas.push(delta));

    server.latest.sendInputTranscript('hello there', { startMs: 1000, endMs: 1400 });
    server.latest.sendInputTranscript('second turn', { startMs: 3000, endMs: 3400 }); // gap → first turn closes
    await waitFor(() => user.length === 1, 1000, 'first user turn');
    expect(user).toEqual(['hello there']);
    await waitFor(() => user.length === 2, 2000, 'idle flush'); // wall-clock idle closes the last one
    expect(user[1]).toBe('second turn');

    server.latest.sendSpeech({ chunks: [mulawToneBase64(100)], transcript: 'Hi, how can I help?', startMs: 5000 });
    await waitFor(() => agent.length === 1, 2000, 'agent turn');
    expect(agent[0]).toEqual({ responseId: 'live_utt_1', text: 'Hi, how can I help?' });
    expect(deltas.join('')).toBe('Hi, how can I help?');
  });

  it('surfaces backend function calls and returns results as item.create + one create', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const calls: Array<{ id: string; name: string; argumentsJson: string; responseId?: string }> = [];
    provider.on('toolCall', (c) => calls.push(c));
    const callId = server.latest.sendFunctionCall({ name: 'lookup', argumentsJson: '{"q":"a"}', delegationId: 'item_9' });
    await waitFor(() => calls.length === 1, 1000, 'tool call');
    expect(calls[0]).toMatchObject({ id: callId, name: 'lookup', argumentsJson: '{"q":"a"}', responseId: 'item_9' });
    // A duplicate envelope for the same call_id is ignored.
    server.latest.sendFunctionCall({ name: 'lookup', argumentsJson: '{"q":"a"}', callId });
    await delay(30);
    expect(calls).toHaveLength(1);
    server.latest.sendBackendCompleted({ delegationId: 'item_9' }); // the response that issued the call ends, as on the wire

    provider.sendToolResult(callId, { ok: true }, { triggerResponse: false });
    provider.sendToolResult('call_other', 'raw string', { triggerResponse: true });
    await server.latest.waitForEvent('response.create');
    const items = server.latest.eventsOfType('response.item.create');
    expect(items[0]!.item).toEqual({ type: 'function_call_output', call_id: callId, output: '{"ok":true}' });
    expect(items[1]!.item).toEqual({ type: 'function_call_output', call_id: 'call_other', output: 'raw string' });
    expect(server.latest.eventsOfType('response.create')).toHaveLength(1);
  });

  /** What reached the backend, in order: `output:<call_id>` per result, `create` per continuation. */
  const backendFrames = (): string[] =>
    server.latest.received
      .filter((f) => f.type === 'response.item.create' || f.type === 'response.create')
      .map((f) => (f.type === 'response.create' ? 'create' : `output:${f.item.call_id}`));

  /** One backend response issuing `count` calls at once; resolves with their ids once the provider surfaced them. */
  const issueBatch = async (count: number): Promise<string[]> => {
    const surfaced: string[] = [];
    const onCall = (call: { id: string }) => {
      surfaced.push(call.id);
    };
    provider.on('toolCall', onCall);
    const callIds = server.latest.sendParallelFunctionCalls(
      Array.from({ length: count }, (_, i) => ({ name: 'search_products', argumentsJson: `{"q":"item ${i}"}` })),
    );
    await waitFor(() => surfaced.length === count, 1000, 'the batch');
    provider.off('toolCall', onCall);
    expect(surfaced).toEqual(callIds);
    return callIds;
  };

  /** The backend response in progress finishes; resolves once the provider has processed it. */
  const completeResponse = async (): Promise<void> => {
    let processed = false;
    provider.once('usage', () => {
      processed = true;
    });
    server.latest.sendBackendCompleted();
    await waitFor(() => processed, 1000, 'the response completion');
  };

  // Field (Oct 2026): ten parallel webhooks drew nine function_call_outputs_required
  // refusals — the backend refuses a continuation while any call of its batch is unanswered.
  describe.each([
    ['0-1-2', [0, 1, 2]],
    ['0-2-1', [0, 2, 1]],
    ['1-0-2', [1, 0, 2]],
    ['1-2-0', [1, 2, 0]],
    ['2-0-1', [2, 0, 1]],
    ['2-1-0', [2, 1, 0]],
  ])('a three-call batch answered in the order %s', (_label, order) => {
    it.each([0, 1, 2, 3])(
      'continues the backend once, after the last output (the response completed after %i results)',
      async (completedAfter) => {
        provider = makeProvider();
        await provider.connect({ instructions: 'x' });
        const errors: Error[] = [];
        provider.on('error', (error) => errors.push(error));
        const callIds = await issueBatch(3);
        for (const [answered, index] of order.entries()) {
          if (answered === completedAfter) await completeResponse();
          provider.sendToolResult(callIds[index]!, { found: index });
        }
        if (completedAfter === order.length) {
          // Every call is answered, but the response that issued them is still running.
          await waitFor(() => backendFrames().length === order.length, 1000, 'the outputs');
          await delay(30);
          expect(backendFrames()).not.toContain('create');
          await completeResponse();
        }
        await server.latest.waitForEvent('response.create');
        await delay(30);
        expect(backendFrames()).toEqual([...order.map((index) => `output:${callIds[index]}`), 'create']);
        expect(errors).toEqual([]);
      },
    );
  });

  it('a lone call answered after its response completed is continued at once', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const [callId] = await issueBatch(1);
    await completeResponse();
    provider.sendToolResult(callId!, { ok: true });
    await server.latest.waitForEvent('response.create');
    expect(backendFrames()).toEqual([`output:${callId}`, 'create']);
  });

  it('a result that arrives before its response completes waits for the completion', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    // Until the response that issued the call finishes, more calls of its batch may be on the way.
    const [callId] = await issueBatch(1);
    provider.sendToolResult(callId!, { ok: true });
    await server.latest.waitForEvent('response.item.create');
    await delay(30);
    expect(backendFrames()).toEqual([`output:${callId}`]);
    await completeResponse();
    await server.latest.waitForEvent('response.create');
    await delay(30);
    expect(backendFrames()).toEqual([`output:${callId}`, 'create']);
  });

  it('a result sent without triggerResponse (a handoff) never continues the backend', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const [callId] = await issueBatch(1);
    await completeResponse();
    provider.sendToolResult(callId!, { status: 'transferring_conversation' }, { triggerResponse: false });
    await server.latest.waitForEvent('response.item.create');
    await delay(30);
    expect(backendFrames()).toEqual([`output:${callId}`]);
  });

  it('a continuation is a running response too: a call it issues is continued after it completes', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const [first] = await issueBatch(1);
    await completeResponse();
    provider.sendToolResult(first!, { ok: true });
    await server.latest.waitForEvent('response.create');
    // The continuation calls one more tool, and the tool answers before that response completes.
    const calls: string[] = [];
    provider.on('toolCall', (call) => calls.push(call.id));
    server.latest.send({
      type: 'response.event',
      delegation_id: null,
      event: {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_next', call_id: 'call_next', name: 'book', arguments: '{}', status: 'completed' },
      },
    });
    await waitFor(() => calls.length === 1, 1000, 'the follow-up call');
    provider.sendToolResult('call_next', { ok: true });
    await server.latest.waitForEvent((f) => f.type === 'response.item.create' && f.item.call_id === 'call_next');
    await delay(30);
    expect(backendFrames()).toEqual([`output:${first}`, 'create', 'output:call_next']);
    await completeResponse();
    await waitFor(() => backendFrames().length === 4, 1000, 'the second continuation');
    expect(backendFrames()).toEqual([`output:${first}`, 'create', 'output:call_next', 'create']);
  });

  it('a refused continuation does not leave the backend marked running', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const errors: Error[] = [];
    provider.on('error', (error) => errors.push(error));
    const [callId] = await issueBatch(1);
    await completeResponse();
    // The server holds a call the provider never saw, so it refuses the continuation.
    server.latest.unansweredCalls.push('call_unseen');
    provider.sendToolResult(callId!, { ok: true });
    await waitFor(() => errors.length === 1, 1000, 'the refusal');
    expect(errors[0]!.message).toMatch(/function_call_outputs_required/);
    expect(errors[0]!.message).toContain('Missing tool results or approvals for: call_unseen.');
    // No run started, so none will finish: the next result is continued at once.
    provider.sendToolResult('call_unseen', { ok: true });
    await waitFor(() => backendFrames().length === 4, 1000, 'the second continuation');
    await delay(30);
    expect(backendFrames()).toEqual([`output:${callId}`, 'create', 'output:call_unseen', 'create']);
    expect(errors).toHaveLength(1);
  });

  it('maps createResponse and sendText onto the three appends', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    provider.createResponse({ instructions: 'Say hello now.' });
    provider.createResponse();
    provider.sendText('Be brief.', { role: 'system' });
    provider.sendText('[keypad] 1234', { role: 'user' });
    provider.sendText('Hi, thanks for calling!', { role: 'assistant' });
    await waitFor(() => server.latest.appends.length === 5, 1000, 'appends');
    expect(server.latest.appends).toEqual([
      { type: 'session.commentary.append', content: 'Say hello now.', delegation_id: null },
      { type: 'session.instructions.append', content: 'Respond to the caller now, without waiting for them to speak.', delegation_id: null },
      { type: 'session.instructions.append', content: 'Be brief.', delegation_id: null },
      { type: 'session.thinking.append', content: '[keypad] 1234', delegation_id: null },
      { type: 'session.thinking.append', content: 'You already said this to the caller earlier: "Hi, thanks for calling!"', delegation_id: null },
    ]);
    // Every append carried an event_id (acks correlate on it).
    for (const frame of server.latest.received.filter((f) => f.type.endsWith('.append'))) {
      expect(typeof frame.event_id).toBe('string');
    }
  });

  it('splits long appends to respect the 500-token cap', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' '); // ≈ 3,100 chars
    expect(splitForAppend(long).length).toBeGreaterThan(1);
    provider.sendText(long, { role: 'system' });
    await waitFor(() => server.latest.appends.length === splitForAppend(long).length, 2000, 'chunks');
    expect(server.latest.appends.map((a) => a.content).join(' ')).toBe(long);
  });

  it('reports duration ticks and backend token usage as usage events', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const usage: ProviderUsage[] = [];
    provider.on('usage', (u) => usage.push(u));
    server.latest.sendUsage(14);
    server.latest.sendBackendCompleted({ usage: { input_tokens: 2480, output_tokens: 40, total_tokens: 2520, input_tokens_details: { cached_tokens: 2126 } } });
    await waitFor(() => usage.length === 2, 1000, 'usage');
    expect(usage[0]).toMatchObject({ audioSeconds: 14, totalTokens: 0 });
    expect(usage[1]).toMatchObject({ inputTokens: 2480, outputTokens: 40, totalTokens: 2520, inputTokenDetails: { cachedTokens: 2126 } });
  });

  it('updateSession: tools reach the backend via session.update; immutable fields are ignored', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const acked = await provider.updateSession({ tools: [{ name: 'new_tool', parameters: { type: 'object' } }] }, { awaitAck: true });
    expect(acked).toBe(true);
    const update = server.latest.eventsOfType('session.update')[0]!;
    expect(update.session).toEqual({ delegation: { type: 'responses', responses: { tools: [{ type: 'function', name: 'new_tool', description: '', parameters: { type: 'object' } }] } } });
    expect(await provider.updateSession({ instructions: 'new voice prompt' })).toBe(false);
    expect(server.latest.eventsOfType('session.update')).toHaveLength(1);
  });

  it('close() sends session.close and waits for session.closed; the close event is not retriable', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const closes: Array<{ retriable: boolean }> = [];
    provider.on('close', (info) => closes.push(info));
    await provider.close();
    expect(server.latest.eventsOfType('session.close')).toHaveLength(1);
    await waitFor(() => closes.length === 1, 1000, 'close event');
    expect(closes[0]!.retriable).toBe(false);
    expect(provider.isConnected).toBe(false);
  });

  it('a server-side expiry is retriable (reconnect with seeded history); a safety close is not', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const closes: Array<{ retriable: boolean }> = [];
    provider.on('close', (info) => closes.push(info));
    server.latest.closeSession('expired', 7200);
    await waitFor(() => closes.length === 1, 1000, 'expired close');
    expect(closes[0]!.retriable).toBe(true);

    await provider.connect({ instructions: 'x', history: [{ role: 'user', text: 'earlier' }] });
    expect(server.latest.startFrame!.session.input[0].content[0].text).toBe('earlier');
    server.latest.closeSession('content');
    await waitFor(() => closes.length === 2, 1000, 'content close');
    expect(closes[1]!.retriable).toBe(false);
  });

  it('an open utterance is closed when the socket drops, so the engine ledger settles', async () => {
    provider = makeProvider();
    await provider.connect({ instructions: 'x' });
    const events: string[] = [];
    provider.on('responseStarted', () => events.push('start'));
    provider.on('responseDone', () => events.push('done'));
    server.latest.send({ type: 'session.output_audio.delta', delta: mulawToneBase64(100) });
    await waitFor(() => events.length === 1, 1000, 'open');
    server.latest.drop();
    await waitFor(() => events.length === 2, 1000, 'done on drop');
    expect(events).toEqual(['start', 'done']);
  });

  it('silence deltas helper matches the real 100 ms cadence', () => {
    const deltas = mulawSilenceDeltas(250);
    expect(deltas).toHaveLength(3);
    expect(Buffer.from(deltas[0]!, 'base64')).toHaveLength(800);
    expect(Buffer.from(deltas[2]!, 'base64')).toHaveLength(400);
  });
});
