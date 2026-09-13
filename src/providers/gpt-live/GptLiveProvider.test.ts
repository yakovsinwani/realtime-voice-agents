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
    new GptLiveProvider({ apiKey: 'sk-test', model: 'gpt-live-1', voice: 'marin', baseUrl: server.url, ...overrides });

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

    provider.sendToolResult(callId, { ok: true }, { triggerResponse: false });
    provider.sendToolResult('call_other', 'raw string', { triggerResponse: true });
    await server.latest.waitForEvent('response.create');
    const items = server.latest.eventsOfType('response.item.create');
    expect(items[0]!.item).toEqual({ type: 'function_call_output', call_id: callId, output: '{"ok":true}' });
    expect(items[1]!.item).toEqual({ type: 'function_call_output', call_id: 'call_other', output: 'raw string' });
    expect(server.latest.eventsOfType('response.create')).toHaveLength(1);
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
