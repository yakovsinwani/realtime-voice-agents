import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOpenAIServer } from '../../testing/FakeOpenAIServer.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import type { ProviderSessionInit } from '../base/BaseRealtimeProvider.js';

const INIT: ProviderSessionInit = {
  instructions: 'You answer the phone.',
  voice: 'marin',
  tools: [{ name: 'noop', parameters: { type: 'object', properties: {} } }],
};

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
