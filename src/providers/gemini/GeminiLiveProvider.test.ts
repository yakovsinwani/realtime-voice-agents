import { beforeEach, describe, expect, it } from 'vitest';
import { FakeGeminiLive } from '../../testing/FakeGeminiLive.js';
import { GeminiLiveProvider } from './GeminiLiveProvider.js';
import { mulawToPcm16 } from '../../audio/mulaw.js';
import { mulawSilenceBase64 } from '../../testing/FakeTwilioMediaStream.js';
import type { ProviderSessionInit } from '../base/BaseRealtimeProvider.js';

function sinePcm24kBase64(freq: number, ms: number, amplitude = 12000): string {
  const samples = Math.round((ms / 1000) * 24000);
  const buf = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / 24000)), i * 2);
  }
  return buf.toString('base64');
}

const INIT: ProviderSessionInit = {
  instructions: 'Answer briefly.',
  voice: 'Kore',
  tools: [{ name: 'lookup', description: 'find', parameters: { type: 'object', properties: {} } }],
};

describe('GeminiLiveProvider', () => {
  let fake: FakeGeminiLive;
  let provider: GeminiLiveProvider;

  beforeEach(() => {
    fake = new FakeGeminiLive();
    provider = new GeminiLiveProvider({
      model: 'gemini-test',
      voice: 'Aoede',
      connector: fake.connector,
    });
  });

  it('connects and builds the live config (voice, tools, VAD, transcription, resumption)', async () => {
    await provider.connect({ ...INIT, vad: { startSensitivity: 'low', silenceDurationMs: 800 } });
    expect(provider.isConnected).toBe(true);
    const config = fake.latest.params.config as any;
    expect(config.systemInstruction).toBe('Answer briefly.');
    expect(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(config.tools[0].functionDeclarations[0].name).toBe('lookup');
    expect(config.realtimeInputConfig.automaticActivityDetection).toEqual({
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
      silenceDurationMs: 800,
    });
    expect(config.inputAudioTranscription).toEqual({});
    expect(config.outputAudioTranscription).toEqual({});
    expect(config.sessionResumption).toEqual({});
  });

  it('transcodes caller mulaw 8k to PCM 16k on the way in', async () => {
    await provider.connect(INIT);
    provider.sendAudio(mulawSilenceBase64(40)); // 320 bytes mulaw
    expect(fake.latest.realtimeInputs.length).toBe(1);
    const sent = fake.latest.realtimeInputs[0]!;
    expect(sent.mimeType).toBe('audio/pcm;rate=16000');
    // ~40ms at 16kHz = 640 samples = 1280 bytes.
    expect(Math.abs(Buffer.from(sent.data, 'base64').length - 1280)).toBeLessThanOrEqual(4);
  });

  it('transcodes model PCM 24k to mulaw 8k and synthesizes turn ids', async () => {
    await provider.connect(INIT);
    const events: string[] = [];
    const audio: string[] = [];
    provider.on('responseStarted', ({ responseId }) => events.push(`start:${responseId}`));
    provider.on('audio', (delta) => audio.push(delta.base64Mulaw));
    provider.on('agentTranscript', ({ text }) => events.push(`transcript:${text}`));
    provider.on('responseDone', ({ responseId }) => events.push(`done:${responseId}`));

    fake.latest.sendAudioTurn({
      pcm24kBase64Chunks: [sinePcm24kBase64(440, 60), sinePcm24kBase64(440, 60)],
      transcript: 'Hello caller.',
    });

    expect(events).toEqual(['start:gturn_1', 'transcript:Hello caller.', 'done:gturn_1']);
    const totalMulawBytes = audio.reduce((a, c) => a + Buffer.from(c, 'base64').length, 0);
    // 120ms at 8kHz ≈ 960 bytes.
    expect(Math.abs(totalMulawBytes - 960)).toBeLessThanOrEqual(8);
    const pcm = mulawToPcm16(new Uint8Array(Buffer.from(audio[0]!, 'base64')));
    const rms = Math.sqrt(pcm.slice(100).reduce((a, v) => a + v * v, 0) / (pcm.length - 100));
    expect(rms).toBeGreaterThan(3000); // audible, not garbage
  });

  it('maps interrupted to userSpeechStarted + responseDone', async () => {
    await provider.connect(INIT);
    const events: string[] = [];
    provider.on('userSpeechStarted', () => events.push('speech'));
    provider.on('responseDone', ({ responseId }) => events.push(`done:${responseId}`));

    fake.latest.serverMessage({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: sinePcm24kBase64(440, 30) } }] } },
    });
    fake.latest.sendInterrupted();
    expect(events).toEqual(['speech', 'done:gturn_1']);
  });

  it('emits toolCall and replies via toolResponse with the function name', async () => {
    await provider.connect(INIT);
    const calls: Array<{ id: string; name: string }> = [];
    provider.on('toolCall', (call) => calls.push({ id: call.id, name: call.name }));

    const id = fake.latest.sendToolCall({ name: 'lookup', args: { orderId: 'A1' } });
    expect(calls).toEqual([{ id, name: 'lookup' }]);

    provider.sendToolResult(id, { status: 'ok' });
    expect(fake.latest.toolResponses).toEqual([
      { functionResponses: [{ id, name: 'lookup', response: { status: 'ok' } }] },
    ]);
  });

  it('accumulates user transcription and flushes it on turn boundaries', async () => {
    await provider.connect(INIT);
    const userTexts: string[] = [];
    provider.on('userTranscript', ({ text }) => userTexts.push(text));
    fake.latest.sendInputTranscription('I need ');
    fake.latest.sendInputTranscription('help');
    fake.latest.sendAudioTurn({ pcm24kBase64Chunks: [sinePcm24kBase64(300, 30)] });
    expect(userTexts).toEqual(['I need help']);
  });

  it('captures resumption handles and resumes on reconnect (didResume)', async () => {
    await provider.connect(INIT);
    const handles: string[] = [];
    provider.on('resumptionUpdate', (handle) => handles.push(handle));
    fake.latest.sendResumptionUpdate('handle-1');
    expect(handles).toEqual(['handle-1']);
    expect(provider.didResume).toBe(false);

    await provider.close();
    await provider.connect(INIT);
    expect((fake.latest.params.config as any).sessionResumption).toEqual({ handle: 'handle-1' });
    expect(provider.didResume).toBe(true);
  });

  it('surfaces goAway with parsed milliseconds', async () => {
    await provider.connect(INIT);
    const warnings: Array<number | undefined> = [];
    provider.on('goAway', ({ timeLeftMs }) => warnings.push(timeLeftMs));
    fake.latest.sendGoAway('12s');
    expect(warnings).toEqual([12_000]);
  });

  it('normalizes usageMetadata', async () => {
    await provider.connect(INIT);
    const usages: Array<{ inputTokens: number; totalTokens: number }> = [];
    provider.on('usage', (usage) => usages.push(usage));
    fake.latest.sendUsage({ promptTokenCount: 11, responseTokenCount: 22, totalTokenCount: 33 });
    expect(usages).toEqual([
      expect.objectContaining({ inputTokens: 11, outputTokens: 22, totalTokens: 33 }),
    ]);
  });

  it('marks unexpected drops retriable', async () => {
    await provider.connect(INIT);
    const closes: Array<{ retriable: boolean }> = [];
    provider.on('close', (info) => closes.push(info));
    fake.latest.drop(1011);
    expect(closes).toEqual([expect.objectContaining({ code: 1011, retriable: true })]);
  });

  it('vad null disables automatic activity detection', async () => {
    await provider.connect({ ...INIT, vad: null });
    expect((fake.latest.params.config as any).realtimeInputConfig.automaticActivityDetection).toEqual({
      disabled: true,
    });
  });
});
