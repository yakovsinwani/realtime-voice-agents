/**
 * Keypad (DTMF) input end-to-end: FakeTwilioMediaStream (the caller's keypad)
 * ⇄ bridge ⇄ OpenAICompatibleProvider ⇄ FakeOpenAIServer. Asserts what lands
 * on the provider wire (the injected user turn + response.create), what the
 * host sees (`keypad.entry` / `keypad.cleared` / raw `dtmf`, the
 * `session.keypad` handle), and the interrupt-on-keypress playback flush.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../agents/Agent.js';
import { DEFAULT_KEYPAD_CLEAR_MESSAGE, DEFAULT_KEYPAD_INSTRUCTIONS } from '../dtmf/KeypadCollector.js';
import type { KeypadEntry } from '../dtmf/KeypadCollector.js';
import { openaiRealtime } from '../openai.js';
import { FakeOpenAIServer } from '../testing/FakeOpenAIServer.js';
import { FakeTwilioMediaStream, mulawSilenceBase64 } from '../testing/FakeTwilioMediaStream.js';
import { TwilioRealtimeBridge } from './TwilioRealtimeBridge.js';
import type { BridgeConfig, SessionOptions } from './config.js';
import type { CallSession } from './CallSession.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const BILLING = new Agent({ name: 'Billing', instructions: 'You handle billing.' });
const RECEPTIONIST = new Agent({
  name: 'Receptionist',
  instructions: 'You answer the phone briefly.',
  voice: 'marin',
  handoffs: [BILLING],
});

describe('keypad input (FakeTwilio ⇄ bridge ⇄ FakeOpenAI)', () => {
  let server: FakeOpenAIServer;
  let bridge: TwilioRealtimeBridge;
  let fake: FakeTwilioMediaStream;

  const makeBridge = (session: Partial<SessionOptions> = {}, overrides: Partial<BridgeConfig> = {}) =>
    new TwilioRealtimeBridge({
      agent: RECEPTIONIST,
      provider: openaiRealtime({ apiKey: 'test', baseUrl: server.url }),
      session: { greeting: { mode: 'user-initiates' }, ...session },
      ...overrides,
    });

  const connectCall = async (): Promise<CallSession> => {
    fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active session');
    return bridge.getSession(fake.callSid)!;
  };

  const type = (keys: string) => {
    for (const key of keys) fake.sendDtmf(key);
  };

  /** User-role conversation items the provider received, text only. */
  const userItems = () =>
    server.latest
      .eventsOfType('conversation.item.create')
      .filter((f) => f.item?.role === 'user')
      .map((f) => f.item.content[0].text as string);

  beforeEach(async () => {
    server = await FakeOpenAIServer.start();
  });

  afterEach(async () => {
    await bridge?.close();
    await server.close();
  });

  it('{} enables defaults: # submits the buffered digits as ONE user turn + response.create; raw dtmf still fires per key', async () => {
    bridge = makeBridge({ keypad: {} });
    const session = await connectCall();
    const entries: KeypadEntry[] = [];
    const raw: string[] = [];
    session.on('keypad.entry', (entry) => entries.push(entry));
    session.on('dtmf', ({ digit }) => raw.push(digit));

    type('123#');

    await waitFor(() => entries.length === 1, 2000, 'keypad.entry');
    expect(entries).toEqual([{ digits: '123', reason: 'submit' }]);
    expect(raw).toEqual(['1', '2', '3', '#']);
    await server.latest.waitForEvent('response.create');
    expect(userItems()).toEqual([
      '[keypad] I typed on my phone keypad: 123 — 3 digits. Digit by digit: 1 2 3',
    ]);
    // The item is a proper user message (not a system note) so the response
    // it triggers answers the entry itself.
    const item = server.latest.eventsOfType('conversation.item.create')[0]!.item;
    expect(item.role).toBe('user');
    expect(item.content[0].type).toBe('input_text');
  });

  it('maxDigits auto-submits without #; the inter-digit timeout flushes a partial entry', async () => {
    bridge = makeBridge({ keypad: { maxDigits: 4, interDigitTimeoutMs: 60 } });
    const session = await connectCall();
    const entries: KeypadEntry[] = [];
    session.on('keypad.entry', (entry) => entries.push(entry));

    type('2024');
    await waitFor(() => entries.length === 1, 2000, 'maxDigits entry');
    expect(entries[0]).toEqual({ digits: '2024', reason: 'maxDigits' });

    type('77'); // caller stops short of 4 digits
    await waitFor(() => entries.length === 2, 2000, 'timeout entry');
    expect(entries[1]).toEqual({ digits: '77', reason: 'timeout' });
    await waitFor(() => userItems().length === 2, 2000, 'both user turns on the wire');
    expect(userItems()[1]).toContain('77 — 2 digits');
  });

  it('* clears: keypad.cleared carries the discarded digits, the model hears the caller is starting over, and the next entry is fresh', async () => {
    bridge = makeBridge({ keypad: {} });
    const session = await connectCall();
    const cleared: Array<{ discarded: string }> = [];
    const entries: KeypadEntry[] = [];
    session.on('keypad.cleared', (info) => cleared.push(info));
    session.on('keypad.entry', (entry) => entries.push(entry));

    type('12*');
    await waitFor(() => cleared.length === 1, 2000, 'keypad.cleared');
    expect(cleared).toEqual([{ discarded: '12' }]);
    expect(session.keypad.digits).toBe('');
    await waitFor(() => userItems().length === 1, 2000, 'clear message');
    expect(userItems()[0]).toBe(DEFAULT_KEYPAD_CLEAR_MESSAGE);

    type('34#');
    await waitFor(() => entries.length === 1, 2000, 'fresh entry');
    expect(entries[0]).toEqual({ digits: '34', reason: 'submit' });
  });

  it('message: false / clearMessage: false inject nothing — events only; a custom message function replaces the wording', async () => {
    bridge = makeBridge({ keypad: { message: false, clearMessage: false } });
    const session = await connectCall();
    const entries: KeypadEntry[] = [];
    session.on('keypad.entry', (entry) => entries.push(entry));

    type('9*9#');
    await waitFor(() => entries.length === 1, 2000, 'entry');
    await delay(30);
    expect(server.latest.eventsOfType('conversation.item.create')).toEqual([]);
    expect(server.latest.eventsOfType('response.create')).toEqual([]);
    await bridge.close();

    bridge = makeBridge({
      keypad: { message: ({ digits, reason }) => `[keypad] code=${digits} via ${reason}` },
    });
    await connectCall();
    type('42#');
    await waitFor(() => userItems().length === 1, 2000, 'custom message');
    expect(userItems()).toEqual(['[keypad] code=42 via submit']);
  });

  it('a keypress stops the agent mid-sentence (clear + playback.interrupted) so the readback never queues behind stale speech', async () => {
    bridge = makeBridge({ keypad: {} });
    const session = await connectCall();
    const interrupted: string[] = [];
    session.on('playback.interrupted', ({ responseId }) => interrupted.push(responseId));

    server.latest.sendAudioResponse({
      responseId: 'monologue',
      chunks: [mulawSilenceBase64(400), mulawSilenceBase64(400)],
      complete: false,
    });
    await waitFor(() => fake.sentMediaPayloads.length === 2, 2000, 'audio at Twilio');
    fake.advancePlayback(200);

    type('5');
    await waitFor(() => fake.clearCount === 1, 2000, 'clear frame');
    expect(interrupted).toEqual(['monologue']);
    expect(session.keypad.digits).toBe('5');
  });

  it('interruptOnKeypress: false lets the agent keep talking while the caller types', async () => {
    bridge = makeBridge({ keypad: { interruptOnKeypress: false } });
    const session = await connectCall();
    const interrupted: string[] = [];
    session.on('playback.interrupted', ({ responseId }) => interrupted.push(responseId));

    server.latest.sendAudioResponse({
      responseId: 'monologue',
      chunks: [mulawSilenceBase64(400), mulawSilenceBase64(400)],
      complete: false,
    });
    await waitFor(() => fake.sentMediaPayloads.length === 2, 2000, 'audio at Twilio');
    fake.advancePlayback(200);

    type('5');
    await delay(30);
    expect(fake.clearCount).toBe(0);
    expect(interrupted).toEqual([]);
    expect(session.keypad.digits).toBe('5');
  });

  it('session.keypad handle: the collector consumes the key BEFORE the raw dtmf event, so a host can claim a key with clear()', async () => {
    bridge = makeBridge({ keypad: {} });
    const session = await connectCall();
    const entries: KeypadEntry[] = [];
    const seenDigits: string[] = [];
    session.on('keypad.entry', (entry) => entries.push(entry));
    session.on('dtmf', ({ digit }) => {
      seenDigits.push(session.keypad.digits); // already includes this key
      // "0" with nothing else buffered = operator: keep it away from the model.
      if (digit === '0' && session.keypad.digits === '0') session.keypad.clear();
    });

    type('0');
    await waitFor(() => seenDigits.length === 1, 2000, 'dtmf seen');
    expect(seenDigits).toEqual(['0']);
    expect(session.keypad.digits).toBe('');

    type('12');
    expect(session.keypad.digits).toBe('12');
    session.keypad.submit();
    expect(entries).toEqual([{ digits: '12', reason: 'submit' }]);
    await waitFor(() => userItems().length === 1, 2000, 'submitted entry');
    await delay(30);
    expect(userItems()).toHaveLength(1); // the claimed "0" never reached the model
  });

  it('appends the keypad note to the agent instructions (init AND in-place handoff); instructions: false leaves them alone', async () => {
    bridge = makeBridge({ keypad: {} });
    const session = await connectCall();
    const initial = server.latest.eventsOfType('session.update')[0]!;
    expect(initial.session.instructions).toContain('You answer the phone briefly.');
    expect(initial.session.instructions).toContain(DEFAULT_KEYPAD_INSTRUCTIONS);

    await session.handoffTo(BILLING);
    await waitFor(() => server.latest.eventsOfType('session.update').length === 2, 2000, 'handoff update');
    const afterHandoff = server.latest.eventsOfType('session.update')[1]!;
    expect(afterHandoff.session.instructions).toContain('You handle billing.');
    expect(afterHandoff.session.instructions).toContain(DEFAULT_KEYPAD_INSTRUCTIONS);
    await bridge.close();

    bridge = makeBridge({ keypad: { instructions: false } });
    await connectCall();
    expect(server.latest.eventsOfType('session.update')[0]!.session.instructions).not.toContain('[keypad]');
    await bridge.close();

    bridge = makeBridge({ keypad: { instructions: 'Digits typed arrive as [keypad] lines; read them back in pairs.' } });
    await connectCall();
    expect(server.latest.eventsOfType('session.update')[0]!.session.instructions).toContain(
      'read them back in pairs',
    );
  });

  it('not configured: raw dtmf only — nothing is injected, the handle is inert, and the instructions are untouched', async () => {
    bridge = makeBridge();
    const session = await connectCall();
    const raw: string[] = [];
    session.on('dtmf', ({ digit }) => raw.push(digit));

    type('12#*');
    await waitFor(() => raw.length === 4, 2000, 'raw dtmf');
    await delay(30);
    expect(session.keypad.digits).toBe('');
    session.keypad.clear();
    session.keypad.submit();
    expect(server.latest.eventsOfType('conversation.item.create')).toEqual([]);
    expect(server.latest.eventsOfType('session.update')[0]!.session.instructions).not.toContain('[keypad]');
  });

  it('teardown drops a pending entry: digits typed right before hangup never fire after the call ended', async () => {
    bridge = makeBridge({ keypad: { interDigitTimeoutMs: 40 } });
    const session = await connectCall();
    const entries: KeypadEntry[] = [];
    session.on('keypad.entry', (entry) => entries.push(entry));

    type('12');
    fake.stop();
    await waitFor(() => session.state === 'ended', 2000, 'call ended');
    await delay(80);
    expect(entries).toEqual([]);
    expect(session.keypad.digits).toBe('');
  });
});
