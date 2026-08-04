import { describe, expect, it, vi } from 'vitest';
import { FakeTwilioMediaStream, mulawSilenceBase64 } from '../testing/FakeTwilioMediaStream.js';
import { TwilioMediaTransport } from './transport.js';
import { connectStreamTwiml, escapeXml } from './twiml.js';
import { parseTwilioMessage } from './messages.js';

describe('parseTwilioMessage', () => {
  it('parses known events and rejects garbage', () => {
    expect(parseTwilioMessage('{"event":"start","streamSid":"MZ1","start":{"streamSid":"MZ1","callSid":"CA1"}}')?.event).toBe('start');
    expect(parseTwilioMessage('not json')).toBeNull();
    expect(parseTwilioMessage('{"event":"someFutureEvent"}')).toBeNull();
    expect(parseTwilioMessage('42')).toBeNull();
  });
});

describe('TwilioMediaTransport', () => {
  it('captures streamSid from start and frames outbound messages with it', async () => {
    const fake = new FakeTwilioMediaStream();
    const transport = new TwilioMediaTransport(fake);
    const startPromise = transport.awaitStart();
    fake.connect({ customParameters: { token: 'abc' } });
    const start = await startPromise;

    expect(start.start.callSid).toBe(fake.callSid);
    expect(start.start.customParameters).toEqual({ token: 'abc' });
    expect(transport.streamSid).toBe(fake.streamSid);

    transport.sendMedia('AAAA');
    transport.sendMark('r1:0');
    transport.sendClear();

    expect(fake.outbound.map((f) => f.event)).toEqual(['media', 'mark', 'clear']);
    expect(fake.outbound[0]!.streamSid).toBe(fake.streamSid);
  });

  it('emits media/stop/dtmf/mark events after start', async () => {
    const fake = new FakeTwilioMediaStream();
    const transport = new TwilioMediaTransport(fake);
    const events: string[] = [];
    transport.on('media', () => events.push('media'));
    transport.on('dtmf', (e) => events.push(`dtmf:${e.dtmf.digit}`));
    transport.on('stop', () => events.push('stop'));

    fake.connect();
    await transport.awaitStart();
    fake.sendMedia(mulawSilenceBase64(20));
    fake.sendDtmf('5');
    fake.stop();

    expect(events).toEqual(['media', 'dtmf:5', 'stop']);
  });

  it('awaitStart rejects on timeout', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeTwilioMediaStream();
      const transport = new TwilioMediaTransport(fake);
      const promise = transport.awaitStart({ timeoutMs: 500 });
      const assertion = expect(promise).rejects.toThrow('not received within 500ms');
      await vi.advanceTimersByTimeAsync(600);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('awaitStart rejects after too many pre-start frames', async () => {
    const fake = new FakeTwilioMediaStream();
    const transport = new TwilioMediaTransport(fake);
    const promise = transport.awaitStart({ maxPreStartMessages: 2 });
    const assertion = expect(promise).rejects.toThrow('no start frame');
    for (let i = 0; i < 3; i++) fake.sendMedia(mulawSilenceBase64(20));
    await assertion;
  });

  it('awaitStart rejects when the socket closes first', async () => {
    const fake = new FakeTwilioMediaStream();
    const transport = new TwilioMediaTransport(fake);
    const promise = transport.awaitStart();
    const assertion = expect(promise).rejects.toThrow('closed before start');
    fake.disconnect();
    await assertion;
  });

  it('throws when sending before start (no streamSid)', () => {
    const transport = new TwilioMediaTransport(new FakeTwilioMediaStream());
    expect(() => transport.sendMedia('AAAA')).toThrow('before the start frame');
  });
});

describe('connectStreamTwiml', () => {
  it('renders a bidirectional Connect/Stream with escaped parameters', () => {
    const xml = connectStreamTwiml({
      wsUrl: 'wss://example.com/media?a=1&b=2',
      parameters: { token: 'a"b<c>', tenant: "t'1&2" },
    });
    expect(xml).toContain('<Connect>');
    expect(xml).toContain('wss://example.com/media?a=1&amp;b=2');
    expect(xml).toContain('value="a&quot;b&lt;c&gt;"');
    expect(xml).toContain('value="t&apos;1&amp;2"');
    expect(xml).not.toContain('<Start>');
  });

  it('self-closes Stream without parameters', () => {
    const xml = connectStreamTwiml({ wsUrl: 'wss://x.dev/ws' });
    expect(xml).toContain('<Stream url="wss://x.dev/ws" />');
  });

  it('escapeXml covers the five XML entities', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;',
    );
  });
});
