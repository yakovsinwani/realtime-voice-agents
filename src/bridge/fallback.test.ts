/**
 * Provider fallback chains: `provider` plus `fallbacks` tried in order while
 * the call is being established. Real WebSockets on the provider side — a
 * "down" provider is a FakeOpenAIServer refusing sessions, so the failure the
 * session sees is the genuine socket-closed-during-setup connect rejection.
 * Fallback is connect-time ONLY: once a provider answers, the call stays with
 * it (pinned here alongside the happy paths).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../agents/Agent.js';
import { openaiRealtime, OPENAI_KEY_ENV_VARS } from '../openai.js';
import { FakeOpenAIServer, type FakeOpenAIServerOptions } from '../testing/FakeOpenAIServer.js';
import { FakeTwilioMediaStream, mulawSilenceBase64 } from '../testing/FakeTwilioMediaStream.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible/OpenAICompatibleProvider.js';
import type { ProviderFactory } from '../providers/base/BaseRealtimeProvider.js';
import { TwilioRealtimeBridge } from './TwilioRealtimeBridge.js';
import type { BridgeConfig } from './config.js';
import type { ProviderFallbackInfo } from './events.js';
import type { CallSession } from './CallSession.js';
import { setTimeout as delay } from 'node:timers/promises';

async function waitFor(predicate: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface ObservedCall {
  session: CallSession;
  fallbacks: ProviderFallbackInfo[];
  failures: Error[];
  ended: string[];
}

describe('provider fallback chain (connect-time)', () => {
  let servers: FakeOpenAIServer[] = [];
  let bridge: TwilioRealtimeBridge;
  let fake: FakeTwilioMediaStream;

  const startServer = async (options: FakeOpenAIServerOptions = {}) => {
    const server = await FakeOpenAIServer.start(options);
    servers.push(server);
    return server;
  };

  /** A named factory against a fake server, so from/to are assertable. */
  const providerFor =
    (server: FakeOpenAIServer, name: string): ProviderFactory =>
    ({ logger }) =>
      new OpenAICompatibleProvider(
        { apiKey: 'test', model: 'gpt-realtime', baseUrl: server.url, providerName: name },
        logger,
      );

  const makeBridge = (config: Partial<BridgeConfig> & Pick<BridgeConfig, 'provider'>) =>
    new TwilioRealtimeBridge({
      agent: new Agent({ name: 'Receptionist', instructions: 'You answer the phone briefly.' }),
      ...config,
    });

  /**
   * Start a call and collect fallback/failure events from session birth —
   * they can fire before the session ever reaches 'active' (or never does).
   */
  const startCall = async (): Promise<ObservedCall> => {
    fake = new FakeTwilioMediaStream();
    let session: CallSession | undefined;
    const fallbacks: ProviderFallbackInfo[] = [];
    const failures: Error[] = [];
    const ended: string[] = [];
    bridge.once('session.started', (s) => {
      session = s;
      s.on('provider.fallback', (info) => fallbacks.push(info));
      s.on('call.failed', (error) => failures.push(error));
      s.on('call.ended', ({ reason }) => ended.push(reason));
    });
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => session !== undefined, 2000, 'session started');
    return { session: session!, fallbacks, failures, ended };
  };

  afterEach(async () => {
    await bridge?.close();
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
  });

  it('falls back to the next provider when the primary refuses to connect', async () => {
    const primary = await startServer({ refuseConnections: true });
    const backup = await startServer();
    bridge = makeBridge({
      provider: providerFor(primary, 'primary'),
      fallbacks: [providerFor(backup, 'backup')],
    });
    const { session, fallbacks } = await startCall();
    await waitFor(() => session.state === 'active', 2000, 'active on the backup');

    expect(primary.refusedConnections).toBe(1);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.from).toBe('primary');
    expect(fallbacks[0]!.to).toBe('backup');
    expect(fallbacks[0]!.error).toBeInstanceOf(Error);

    // The call runs normally on the backup: greeting → audio → mark-confirmed playback.
    await backup.latest.waitForEvent('response.create');
    const finishes: string[] = [];
    session.on('playback.finished', ({ responseId }) => finishes.push(responseId));
    backup.latest.sendAudioResponse({
      responseId: 'greet',
      chunks: [mulawSilenceBase64(100), mulawSilenceBase64(100)],
    });
    await waitFor(() => fake.sentMediaPayloads.length === 2, 2000, 'media at Twilio');
    await waitFor(
      () => fake.outbound.filter((f) => f.event === 'mark').length === 2,
      2000,
      'first + final checkpoint marks',
    );
    fake.playAll();
    await waitFor(() => finishes.includes('greet'), 2000, 'playback finished on the backup');
  });

  it('walks the whole chain in order until a provider answers', async () => {
    const primary = await startServer({ refuseConnections: true });
    const second = await startServer({ refuseConnections: true });
    const third = await startServer();
    bridge = makeBridge({
      provider: providerFor(primary, 'primary'),
      fallbacks: [providerFor(second, 'second'), providerFor(third, 'third')],
    });
    const { session, fallbacks } = await startCall();
    await waitFor(() => session.state === 'active', 2000, 'active on the last fallback');

    expect(fallbacks.map((f) => `${f.from}->${f.to}`)).toEqual(['primary->second', 'second->third']);
    expect(third.connections).toHaveLength(1);
  });

  it('fails the call only when the whole chain is exhausted', async () => {
    const primary = await startServer({ refuseConnections: true });
    const backup = await startServer({ refuseConnections: true });
    bridge = makeBridge({
      provider: providerFor(primary, 'primary'),
      fallbacks: [providerFor(backup, 'backup')],
    });
    const { session, fallbacks, failures, ended } = await startCall();
    await waitFor(() => session.state === 'ended', 2000, 'call failed');

    expect(fallbacks.map((f) => `${f.from}->${f.to}`)).toEqual(['primary->backup']);
    expect(failures).toHaveLength(1);
    expect(ended).toEqual(['provider-failed']);
    expect(fake.wasClosedByBridge).toBe(true);
    expect(bridge.getSession(fake.callSid)).toBeUndefined();
  });

  it('never falls back mid-call: a dropped connection reconnects to the SAME provider', async () => {
    const primary = await startServer();
    const backup = await startServer();
    bridge = makeBridge({
      provider: providerFor(primary, 'primary'),
      fallbacks: [providerFor(backup, 'backup')],
      session: { reconnect: { maxAttempts: 3, initialDelayMs: 20, maxDelayMs: 50, jitter: false } },
    });
    const { session, fallbacks } = await startCall();
    await waitFor(() => session.state === 'active', 2000, 'active on the primary');
    const reconnects: string[] = [];
    session.on('provider.reconnected', () => reconnects.push('ok'));

    primary.latest.drop(1011); // retriable mid-call failure
    await waitFor(() => primary.connections.length === 2, 3000, 'second PRIMARY connection');
    await waitFor(() => reconnects.includes('ok'), 2000, 'reconnected');

    expect(session.state).toBe('active');
    expect(fallbacks).toHaveLength(0);
    expect(backup.connections).toHaveLength(0);
  });

  it('never falls back mid-call: a non-retriable close fails the call even with fallbacks configured', async () => {
    const primary = await startServer();
    const backup = await startServer();
    bridge = makeBridge({
      provider: providerFor(primary, 'primary'),
      fallbacks: [providerFor(backup, 'backup')],
    });
    const { session, fallbacks, ended } = await startCall();
    await waitFor(() => session.state === 'active', 2000, 'active on the primary');

    primary.latest.drop(1008); // auth/policy — retrying cannot help
    await waitFor(() => session.state === 'ended', 2000, 'call ended');

    expect(ended).toEqual(['provider-failed']);
    expect(fallbacks).toHaveLength(0);
    expect(backup.connections).toHaveLength(0);
  });

  // How real providers surface an invalid/expired key, exhausted credits, and
  // an internal error: an HTTP rejection of the WebSocket upgrade itself.
  it.each([
    [401, 'invalid_api_key (expired or revoked)'],
    [403, 'insufficient_quota: credits exhausted'],
    [500, 'internal_server_error'],
  ])('falls back when the primary rejects the upgrade with HTTP %d', async (status, body) => {
    const primary = await startServer({ rejectUpgrade: { status, body } });
    const backup = await startServer();
    bridge = makeBridge({
      provider: providerFor(primary, 'primary'),
      fallbacks: [providerFor(backup, 'backup')],
    });
    const { session, fallbacks } = await startCall();
    await waitFor(() => session.state === 'active', 2000, 'active on the backup');

    expect(primary.rejectedUpgrades).toBe(1);
    expect(fallbacks).toHaveLength(1);
    // The provider's actual verdict (status + body) travels in the event.
    expect(String(fallbacks[0]!.error)).toContain(`HTTP ${status}`);
    expect(String(fallbacks[0]!.error)).toContain(body);
  });

  it('missing API key: openaiRealtime() defers the failure to call time so the chain absorbs it', async () => {
    const backup = await startServer();
    const saved = OPENAI_KEY_ENV_VARS.map((name) => [name, process.env[name]] as const);
    for (const name of OPENAI_KEY_ENV_VARS) delete process.env[name];
    try {
      // Must NOT throw here (config build time) — the chain could never be
      // constructed otherwise.
      bridge = makeBridge({
        provider: openaiRealtime(),
        fallbacks: [providerFor(backup, 'backup')],
      });
      const { session, fallbacks } = await startCall();
      await waitFor(() => session.state === 'active', 2000, 'active on the backup');

      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]!.to).toBe('backup');
      expect(String(fallbacks[0]!.error)).toContain('apiKey missing');
    } finally {
      for (const [name, value] of saved) {
        if (value !== undefined) process.env[name] = value;
      }
    }
  });

  it('skips a fallback whose factory throws and keeps walking the chain', async () => {
    const primary = await startServer({ refuseConnections: true });
    const healthy = await startServer();
    const broken: ProviderFactory = () => {
      throw new Error('bad fallback config');
    };
    bridge = makeBridge({
      provider: providerFor(primary, 'primary'),
      fallbacks: [broken, providerFor(healthy, 'healthy')],
    });
    const { session, fallbacks } = await startCall();
    await waitFor(() => session.state === 'active', 2000, 'active on the healthy fallback');

    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.to).toBe('healthy');
    expect(String(fallbacks[0]!.error)).toContain('bad fallback config');
  });

  it('pre-synthesized greeting plays while the chain advances, and seeds the fallback provider', async () => {
    const primary = await startServer({ refuseConnections: true });
    const backup = await startServer();
    const greetingText = 'Hi, thanks for calling!';
    bridge = makeBridge({
      provider: providerFor(primary, 'primary'),
      fallbacks: [providerFor(backup, 'backup')],
      session: {
        greeting: {
          mode: 'agent-initiates',
          preSynthesized: { audio: Buffer.from(mulawSilenceBase64(400), 'base64'), text: greetingText },
        },
      },
    });
    const { session } = await startCall();
    // Burst-written before any provider handshake — the caller hears a voice
    // even though the primary never came up.
    await waitFor(() => fake.sentMediaPayloads.length > 0, 2000, 'greeting at Twilio');
    await waitFor(() => session.state === 'active', 2000, 'active on the backup');

    // The fallback provider is seeded with the already-played greeting so it
    // continues from it instead of greeting twice.
    const seeded = await backup.latest.waitForEvent(
      (f) => f.type === 'conversation.item.create' && f.item?.role === 'assistant',
    );
    expect(seeded.item.content[0].text).toBe(greetingText);
  });
});
