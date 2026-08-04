/** Minimal inbound-call agent on Express — the whole thing. */

import express from 'express';
import expressWs from 'express-ws';
import { Agent, TwilioRealtimeBridge, connectStreamTwiml, consoleLogger } from 'twilio-realtime-agents';
import { openaiRealtime } from 'twilio-realtime-agents/openai';

const PUBLIC_WS_URL = process.env.PUBLIC_WS_URL ?? 'wss://example.ngrok.app';

const bridge = new TwilioRealtimeBridge({
  agent: new Agent({
    name: 'Demo Agent',
    instructions:
      'You answer the phone for a developer demo. One or two short sentences at a time. ' +
      'Greet the caller, then ask how you can help.',
    voice: 'marin',
  }),
  provider: openaiRealtime(),
  builtinTools: { finishCall: true },
  logger: consoleLogger(),
});

const { app } = expressWs(express());

app.post('/twilio/voice', (_req, res) => {
  res.type('text/xml').send(connectStreamTwiml({ wsUrl: `${PUBLIC_WS_URL}/twilio/media-stream` }));
});

app.ws('/twilio/media-stream', (ws) => {
  bridge.handleConnection(ws as never);
});

app.listen(3000, () => console.log('listening on :3000'));
