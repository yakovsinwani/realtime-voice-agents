import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { FakeOpenAIServer } from '../../testing/FakeOpenAIServer.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderConfig,
} from './OpenAICompatibleProvider.js';
import type { ProviderSessionInit } from '../base/BaseRealtimeProvider.js';

const INIT: ProviderSessionInit = {
  instructions: 'You answer the phone.',
  voice: 'marin',
  tools: [{ name: 'noop', parameters: { type: 'object', properties: {} } }],
};

async function waitFor(predicate: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('OpenAICompatibleProvider against FakeOpenAIServer', () => {
  let server: FakeOpenAIServer;
  let provider: OpenAICompatibleProvider;

  beforeEach(async () => {
    server = await FakeOpenAIServer.start();
    provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      model: 'gpt-realtime',
      baseUrl: server.url,
    });
  });

  afterEach(async () => {
    await provider.close();
    await server.close();
  });

  it('completes the session handshake and reports connected', async () => {
    await provider.connect(INIT);
    expect(provider.isConnected).toBe(true);

    const update = await server.latest.waitForEvent('session.update');
    expect((update.session as any).audio.input.format).toEqual({ type: 'audio/pcmu' });
    expect((update.session as any).instructions).toBe('You answer the phone.');
  });

  it('forwards caller audio as input_audio_buffer.append', async () => {
    await provider.connect(INIT);
    provider.sendAudio('AAAA');
    provider.sendAudio('BBBB');
    await server.latest.waitForEvent((f) => f.type === 'input_audio_buffer.append' && f.audio === 'BBBB');
    expect(server.latest.appendedAudio).toEqual(['AAAA', 'BBBB']);
  });

  it('emits normalized audio / response / transcript / usage events', async () => {
    await provider.connect(INIT);
    const events: string[] = [];
    const audio: string[] = [];
    let usageTotal = 0;
    provider.on('responseStarted', ({ responseId }) => events.push(`started:${responseId}`));
    provider.on('outputItemAdded', ({ itemId }) => events.push(`item:${itemId}`));
    provider.on('audio', (delta) => audio.push(delta.base64Mulaw));
    provider.on('agentTranscript', ({ text }) => events.push(`transcript:${text}`));
    provider.on('responseDone', ({ responseId }) => events.push(`done:${responseId}`));
    provider.on('usage', (usage) => (usageTotal = usage.totalTokens));

    server.latest.sendAudioResponse({
      responseId: 'resp_a',
      itemId: 'item_a',
      chunks: ['QUJD', 'REVG'],
      transcript: 'Hello there.',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([
      'started:resp_a',
      'item:item_a',
      'transcript:Hello there.',
      'done:resp_a',
    ]);
    expect(audio).toEqual(['QUJD', 'REVG']);
    expect(usageTotal).toBe(30);
  });

  it('emits toolCall and returns results as function_call_output + response.create', async () => {
    await provider.connect(INIT);
    const calls: Array<{ id: string; name: string; argumentsJson: string }> = [];
    provider.on('toolCall', (call) => calls.push(call));

    const callId = server.latest.sendToolCall({ name: 'lookup', argumentsJson: '{"orderId":"7"}' });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([
      expect.objectContaining({ id: callId, name: 'lookup', argumentsJson: '{"orderId":"7"}' }),
    ]);

    provider.sendToolResult(callId, { status: 'shipped' });
    const item = await server.latest.waitForEvent('conversation.item.create');
    expect(item.item.type).toBe('function_call_output');
    expect(item.item.call_id).toBe(callId);
    expect(JSON.parse(item.item.output)).toEqual({ status: 'shipped' });
    await server.latest.waitForEvent('response.create');
  });

  it('sends truncate frames with rounded audio_end_ms', async () => {
    await provider.connect(INIT);
    provider.truncatePlayback('item_9', 1234.56);
    const frame = await server.latest.waitForEvent('conversation.item.truncate');
    expect(frame).toMatchObject({ item_id: 'item_9', content_index: 0, audio_end_ms: 1235 });
  });

  it('emits speech events for VAD frames', async () => {
    await provider.connect(INIT);
    const events: string[] = [];
    provider.on('userSpeechStarted', () => events.push('start'));
    provider.on('userSpeechStopped', () => events.push('stop'));
    provider.on('userTranscript', ({ text }) => events.push(`text:${text}`));
    server.latest.sendSpeechStarted();
    server.latest.sendSpeechStopped();
    server.latest.sendUserTranscript('hi there');
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(['start', 'stop', 'text:hi there']);
  });

  it('updateSession re-sends the merged session payload', async () => {
    await provider.connect(INIT);
    await provider.updateSession({ instructions: 'You are now billing.' });
    const updates = await server.latest.waitForEvent(
      (f) => f.type === 'session.update' && f.session.instructions === 'You are now billing.',
    );
    expect((updates.session as any).audio.output.voice).toBe('marin');
  });

  it('marks unexpected drops retriable and intentional closes not', async () => {
    await provider.connect(INIT);
    const closes: Array<{ code?: number; retriable: boolean }> = [];
    provider.on('close', (info) => closes.push(info));

    server.latest.drop(1011);
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toEqual([expect.objectContaining({ code: 1011, retriable: true })]);
  });

  it('does not offer permessage-deflate on the provider socket', async () => {
    await provider.connect(INIT);
    // Realtime audio path: zlib per delta adds latency jitter for no gain.
    expect(server.latest.upgradeHeaders['sec-websocket-extensions']).toBeUndefined();
  });

  it('holds response.create while a response is active, sends it on response.done', async () => {
    await provider.connect(INIT);
    let started = 0;
    provider.on('responseStarted', () => started++);
    server.latest.send({ type: 'response.created', response: { id: 'busy' } });
    await waitFor(() => started === 1, 2000, 'responseStarted');

    provider.createResponse({ instructions: 'Say goodbye now.' });
    await delay(50);
    expect(server.latest.eventsOfType('response.create')).toHaveLength(0);

    server.latest.send({ type: 'response.done', response: { id: 'busy', status: 'completed' } });
    const create = await server.latest.waitForEvent('response.create');
    expect(create.response?.instructions).toBe('Say goodbye now.');
  });

  it('coalesces creates queued during a response; instructions survive a later bare create', async () => {
    await provider.connect(INIT);
    let started = 0;
    provider.on('responseStarted', () => started++);
    server.latest.send({ type: 'response.created', response: { id: 'busy' } });
    await waitFor(() => started === 1, 2000, 'responseStarted');

    provider.createResponse();
    provider.createResponse({ instructions: 'Wrap up the call.' });
    provider.createResponse();

    server.latest.send({ type: 'response.done', response: { id: 'busy', status: 'completed' } });
    const create = await server.latest.waitForEvent('response.create');
    expect(create.response?.instructions).toBe('Wrap up the call.');
    await delay(50);
    expect(server.latest.eventsOfType('response.create')).toHaveLength(1);
  });

  it('treats conversation_already_has_active_response as benign and re-arms the create', async () => {
    await provider.connect(INIT);
    const errors: Error[] = [];
    provider.on('error', (error) => errors.push(error));

    provider.createResponse({ instructions: 'Announce the transfer.' });
    await server.latest.waitForEvent('response.create');
    // A VAD-created response beat us to it — the server rejects our create.
    server.latest.sendError({
      type: 'invalid_request_error',
      code: 'conversation_already_has_active_response',
      message: 'Conversation already has an active response in progress: resp_vad.',
    });
    await delay(50);
    expect(errors).toHaveLength(0);

    // The response that beat us completes → the rejected create fires again.
    server.latest.send({ type: 'response.done', response: { id: 'resp_vad', status: 'completed' } });
    await waitFor(
      () => server.latest.eventsOfType('response.create').length === 2,
      2000,
      'retried response.create',
    );
    const retried = server.latest.eventsOfType('response.create')[1]!;
    expect(retried.response?.instructions).toBe('Announce the transfer.');
  });

  it('ignores response_cancel_not_active errors', async () => {
    await provider.connect(INIT);
    const errors: Error[] = [];
    provider.on('error', (error) => errors.push(error));
    server.latest.sendError({
      type: 'invalid_request_error',
      code: 'response_cancel_not_active',
      message: 'Cancellation failed: no active response found',
    });
    await delay(50);
    expect(errors).toHaveLength(0);
  });

  it('surfaces an HTTP upgrade rejection with its status and body', async () => {
    const { createServer } = await import('node:http');
    const rejecting = createServer();
    rejecting.on('upgrade', (_request, socket) => {
      const body = '{"error":"Your newly created team doesn\'t have any credits yet."}';
      socket.end(
        'HTTP/1.1 403 Forbidden\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          'Connection: close\r\n' +
          '\r\n' +
          body,
      );
    });
    await new Promise<void>((resolve) => rejecting.listen(0, '127.0.0.1', resolve));
    const { port } = rejecting.address() as { port: number };
    const failing = new OpenAICompatibleProvider({
      apiKey: 'k',
      model: 'gpt-realtime',
      baseUrl: `ws://127.0.0.1:${port}`,
      connectTimeoutMs: 1000,
    });
    await expect(failing.connect(INIT)).rejects.toThrow(/HTTP 403.*credits/);
    await failing.close();
    await new Promise<void>((resolve) => rejecting.close(() => resolve()));
  });

  it("ignores xAI's cancel-race shape (generic code, telltale message)", async () => {
    await provider.connect(INIT);
    const errors: Error[] = [];
    provider.on('error', (error) => errors.push(error));
    // xAI reports the same benign race without the dedicated OpenAI code.
    server.latest.sendError({
      type: 'invalid_request_error',
      code: 'invalid_request_error',
      message: 'Cancellation failed: no active response found',
    });
    await delay(50);
    expect(errors).toHaveLength(0);
  });

  it('rejects connect when the server closes with a policy code during setup', async () => {
    const strict = await FakeOpenAIServer.start({ autoAckSessionUpdate: false });
    const failing = new OpenAICompatibleProvider({
      apiKey: 'bad',
      model: 'gpt-realtime',
      baseUrl: strict.url,
      connectTimeoutMs: 300,
    });
    await expect(failing.connect(INIT)).rejects.toThrow('not ready within 300ms');
    await failing.close();
    await strict.close();
  });
});

describe('serialized session updates + ACKed effectiveVad', () => {
  let server: FakeOpenAIServer;
  const providers: OpenAICompatibleProvider[] = [];

  const makeProvider = (config: Partial<OpenAICompatibleProviderConfig> = {}) => {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      model: 'gpt-realtime',
      baseUrl: server.url,
      ...config,
    });
    providers.push(provider);
    return provider;
  };

  /** connect() resolves only on session.updated — ack the handshake by hand. */
  const connectManualAck = async (provider: OpenAICompatibleProvider, init: ProviderSessionInit) => {
    const pending = provider.connect(init);
    const conn = await server.waitForConnection();
    await conn.waitForEvent('session.update');
    conn.send({ type: 'session.updated', session: {} });
    await pending;
    return conn;
  };

  const vadOf = (frame: Record<string, any>) => (frame.session as any)?.audio?.input?.turn_detection;

  beforeEach(async () => {
    server = await FakeOpenAIServer.start({ autoAckSessionUpdate: false });
  });

  afterEach(async () => {
    for (const provider of providers.splice(0)) await provider.close();
    await server.close();
  });

  it('re-injects interrupt_response: false on a vad patch (bridge-owned barge-in survives updateSession)', async () => {
    const provider = makeProvider();
    const conn = await connectManualAck(provider, { ...INIT, bridgeOwnsInterruptions: true });
    void provider.updateSession({ vad: { type: 'server', threshold: 0.6 } });
    const update = await conn.waitForEvent(
      (f) => f.type === 'session.update' && vadOf(f)?.threshold === 0.6,
    );
    expect(vadOf(update)).toEqual({ type: 'server_vad', threshold: 0.6, interrupt_response: false });
  });

  it('lets an explicit interruptResponse in the vad patch win over the injection', async () => {
    const provider = makeProvider();
    const conn = await connectManualAck(provider, { ...INIT, bridgeOwnsInterruptions: true });
    void provider.updateSession({ vad: { type: 'server', threshold: 0.6, interruptResponse: true } });
    const update = await conn.waitForEvent(
      (f) => f.type === 'session.update' && vadOf(f)?.threshold === 0.6,
    );
    expect(vadOf(update).interrupt_response).toBe(true);
  });

  it('getEffectiveVad reflects the ACKed connect config, incl. provider defaultVad + injection', async () => {
    const provider = makeProvider({ defaultVad: { type: 'server', threshold: 0.7 } });
    expect(provider.getEffectiveVad()).toBeUndefined();
    await connectManualAck(provider, { ...INIT, bridgeOwnsInterruptions: true });
    expect(provider.getEffectiveVad()).toEqual({
      interruptResponse: false,
      type: 'server',
      threshold: 0.7,
    });
  });

  it('moves effectiveVad only when the update is acknowledged', async () => {
    const provider = makeProvider();
    const conn = await connectManualAck(provider, {
      ...INIT,
      vad: { type: 'server', threshold: 0.5 },
      serializedSessionUpdates: true,
    });
    const acked = provider.updateSession({ vad: { type: 'server', threshold: 0.9 } }, { awaitAck: true });
    await conn.waitForEvent((f) => f.type === 'session.update' && vadOf(f)?.threshold === 0.9);
    // Sent but not acknowledged: the effective truth is still the old config.
    expect(provider.getEffectiveVad()).toEqual({ type: 'server', threshold: 0.5 });
    conn.send({ type: 'session.updated', session: {} });
    await expect(acked).resolves.toBe(true);
    expect(provider.getEffectiveVad()).toEqual({ type: 'server', threshold: 0.9 });
  });

  it('without serializedSessionUpdates, updates hit the wire immediately (legacy behavior pinned)', async () => {
    const provider = makeProvider();
    const conn = await connectManualAck(provider, INIT);
    await provider.updateSession({ instructions: 'A' });
    await provider.updateSession({ instructions: 'B' });
    await conn.waitForEvent((f) => f.type === 'session.update' && f.session.instructions === 'B');
    // Handshake + A + B all on the wire with zero acks granted.
    expect(conn.eventsOfType('session.update')).toHaveLength(3);
  });

  it('serializes updates, snapshots each payload at enqueue, and acks per entry (A/B/C isolation)', async () => {
    const provider = makeProvider();
    const conn = await connectManualAck(provider, {
      ...INIT,
      vad: { type: 'server', threshold: 0.5 },
      serializedSessionUpdates: true,
    });
    const a = provider.updateSession({ instructions: 'A' }, { awaitAck: true });
    const b = provider.updateSession({ vad: { type: 'server', threshold: 0.6 } }, { awaitAck: true });
    const c = provider.updateSession({ vad: { type: 'server', threshold: 0.8 } }, { awaitAck: true });

    await conn.waitForEvent((f) => f.type === 'session.update' && f.session.instructions === 'A');
    // Only A is in flight; B and C wait for acks.
    expect(conn.eventsOfType('session.update')).toHaveLength(2);

    conn.send({ type: 'session.updated', session: {} }); // ack A
    await expect(a).resolves.toBe(true);
    // B's payload was snapshotted before C merged: 0.6 on the wire, not 0.8.
    // (A crooked snapshot would send 0.8 here and this wait would time out.)
    await conn.waitForEvent((f) => f.type === 'session.update' && vadOf(f)?.threshold === 0.6);
    expect(
      conn.eventsOfType('session.update').filter((f) => vadOf(f)?.threshold === 0.8),
    ).toHaveLength(0);

    conn.send({ type: 'session.updated', session: {} }); // ack B
    await expect(b).resolves.toBe(true);
    expect(provider.getEffectiveVad()).toEqual({ type: 'server', threshold: 0.6 });

    await conn.waitForEvent((f) => f.type === 'session.update' && vadOf(f)?.threshold === 0.8);
    conn.send({ type: 'session.updated', session: {} }); // ack C
    await expect(c).resolves.toBe(true);
    expect(provider.getEffectiveVad()).toEqual({ type: 'server', threshold: 0.8 });
  });

  it('desyncs the connection when an ack times out: resolve false, drop the socket', async () => {
    const provider = makeProvider({ sessionUpdateAckTimeoutMs: 120 });
    const conn = await connectManualAck(provider, { ...INIT, serializedSessionUpdates: true });
    const closes: Array<{ retriable: boolean }> = [];
    provider.on('close', (info) => closes.push(info));
    const acked = provider.updateSession({ vad: { type: 'server', threshold: 0.9 } }, { awaitAck: true });
    await expect(acked).resolves.toBe(false);
    await waitFor(() => closes.length === 1, 2000, 'desync close');
    expect(closes[0]!.retriable).toBe(true);
    // The unacked value was never promoted to effective truth.
    expect(provider.getEffectiveVad()).toBeUndefined();
    void conn;
  });

  it('settles queued updates as not-acked when the socket drops', async () => {
    const provider = makeProvider();
    const conn = await connectManualAck(provider, { ...INIT, serializedSessionUpdates: true });
    const a = provider.updateSession({ instructions: 'A' }, { awaitAck: true });
    const b = provider.updateSession({ instructions: 'B' }, { awaitAck: true });
    conn.drop(1011);
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(false);
  });
});
