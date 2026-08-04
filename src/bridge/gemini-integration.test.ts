/** Full bridge over the Gemini provider (fake SDK seam) — proves the engine is provider-agnostic. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../agents/Agent.js';
import { geminiLive } from '../gemini.js';
import { FakeGeminiLive } from '../testing/FakeGeminiLive.js';
import { FakeTwilioMediaStream, mulawSilenceBase64 } from '../testing/FakeTwilioMediaStream.js';
import { TwilioRealtimeBridge } from './TwilioRealtimeBridge.js';
import type { CallSession } from './CallSession.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function pcm24k(ms: number): string {
  const samples = Math.round((ms / 1000) * 24000);
  const buf = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2);
  }
  return buf.toString('base64');
}

describe('bridge over Gemini Live', () => {
  let fakeGemini: FakeGeminiLive;
  let bridge: TwilioRealtimeBridge;
  let fake: FakeTwilioMediaStream;

  beforeEach(() => {
    fakeGemini = new FakeGeminiLive();
    bridge = new TwilioRealtimeBridge({
      agent: new Agent({ name: 'Concierge', instructions: 'Be brief.', voice: 'Kore' }),
      provider: geminiLive({ connector: fakeGemini.connector, model: 'gemini-test' }),
      session: { greeting: { mode: 'user-initiates' } },
    });
  });

  afterEach(async () => {
    await bridge.close();
  });

  const connectCall = async (): Promise<CallSession> => {
    fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active session');
    return bridge.getSession(fake.callSid)!;
  };

  it('caller audio reaches Gemini as 16k PCM; model audio reaches Twilio as mulaw with marks', async () => {
    const session = await connectCall();
    const playback: string[] = [];
    session.on('playback.finished', ({ responseId }) => playback.push(responseId));

    fake.sendSilence(40);
    await waitFor(() => fakeGemini.latest.realtimeInputs.length >= 2, 2000, 'audio upstream');
    expect(fakeGemini.latest.realtimeInputs[0]!.mimeType).toBe('audio/pcm;rate=16000');

    fakeGemini.latest.sendAudioTurn({ pcm24kBase64Chunks: [pcm24k(120)], transcript: 'Hi.' });
    await waitFor(() => fake.sentMediaPayloads.length >= 1, 2000, 'media at Twilio');
    expect(fake.outbound.some((f) => f.event === 'mark')).toBe(true);

    fake.playAll();
    await waitFor(() => playback.length === 1, 2000, 'playback finished');
    expect(playback[0]).toBe('gturn_1');
  });

  it('barge-in via Gemini interrupted: Twilio buffer cleared, no truncate frames attempted', async () => {
    const session = await connectCall();
    const interrupted: string[] = [];
    session.on('playback.interrupted', ({ responseId }) => interrupted.push(responseId));

    // Long turn queued at Twilio, partially played.
    fakeGemini.latest.serverMessage({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm24k(400) } }] } },
    });
    await waitFor(() => fake.sentMediaPayloads.length >= 1, 2000, 'audio at Twilio');
    fake.advancePlayback(100);

    fakeGemini.latest.sendInterrupted();
    await waitFor(() => fake.clearCount === 1, 2000, 'clear sent');
    expect(interrupted).toEqual(['gturn_1']);
  });

  it('tools round-trip through toolResponse', async () => {
    const { tool } = await import('../tools/tool.js');
    const { z } = await import('zod');
    await bridge.close();
    bridge = new TwilioRealtimeBridge({
      agent: new Agent({
        name: 'C',
        instructions: 'x',
        tools: [
          tool({
            name: 'check_balance',
            description: 'balance',
            parameters: z.object({ account: z.string() }),
            execute: async ({ account }) => ({ account, balance: 42 }),
          }),
        ],
      }),
      provider: geminiLive({ connector: fakeGemini.connector, model: 'gemini-test' }),
      session: { greeting: { mode: 'user-initiates' } },
    });
    await connectCall();

    const callId = fakeGemini.latest.sendToolCall({ name: 'check_balance', args: { account: 'X9' } });
    await waitFor(() => fakeGemini.latest.toolResponses.length === 1, 2000, 'tool response');
    expect(fakeGemini.latest.toolResponses[0]!.functionResponses[0]).toEqual({
      id: callId,
      name: 'check_balance',
      response: { account: 'X9', balance: 42 },
    });
  });

  it('reconnects with a resumption handle and skips transcript re-injection', async () => {
    const session = await connectCall();
    const events: string[] = [];
    session.on('provider.reconnected', () => events.push('reconnected'));

    fakeGemini.latest.sendResumptionUpdate('h-42');
    fakeGemini.latest.sendInputTranscription('hello there');
    fakeGemini.latest.sendAudioTurn({ pcm24kBase64Chunks: [pcm24k(30)], transcript: 'Hey.' });
    fake.playAll();
    await waitFor(() => session.transcript.length === 2, 2000, 'transcript recorded');

    fakeGemini.latest.drop(1011);
    const second = await fakeGemini.waitForSessions(2, 3000);
    await waitFor(() => events.includes('reconnected'), 3000, 'reconnected');
    expect((second.params.config as any).sessionResumption).toEqual({ handle: 'h-42' });
    // No transcript re-injection on a resumed session.
    expect(second.clientContents).toHaveLength(0);
  });
});
