/**
 * Full-featured example: inbound + outbound calls, multi-agent handoff,
 * tools with different execution strategies, hold audio, graceful hangup.
 *
 * Quick start:
 *   1. cp .env.example .env  (fill in keys)
 *   2. npm install && npm run dev
 *   3. ngrok http 3000
 *   4. Point your Twilio number's Voice webhook at
 *      POST https://<your-ngrok-host>/twilio/voice
 *   5. Call the number.
 */

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import * as z from 'zod';
import {
  Agent,
  TwilioRealtimeBridge,
  connectStreamTwiml,
  consoleLogger,
  tool,
} from 'realtime-voice-agents';
import { openaiRealtime } from 'realtime-voice-agents/openai';

const PORT = Number(process.env.PORT ?? 3000);
/** Public wss:// URL of this server (your ngrok host). */
const PUBLIC_WS_URL = process.env.PUBLIC_WS_URL ?? 'wss://example.ngrok.app';

// ---- tools -----------------------------------------------------------------

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Look up the status of a customer order by its id.',
  parameters: z.object({ orderId: z.string().describe('The order id, e.g. A-12345') }),
  // sync (default): the model waits; hold audio covers the silence.
  backgroundAudio: 'keyboard-typing',
  execute: async ({ orderId }) => {
    await new Promise((r) => setTimeout(r, 2500)); // pretend this is slow
    return { orderId, status: 'shipped', eta: 'tomorrow' };
  },
});

const sendConfirmationSms = tool({
  name: 'send_confirmation_sms',
  description: 'Text the caller a confirmation of what was discussed.',
  parameters: z.object({ summary: z.string() }),
  strategy: 'dispatch', // fire-and-forget: the agent keeps talking
  execute: async ({ summary }, ctx) => {
    ctx.logger.info('would send SMS', { to: ctx.callInfo.from, summary });
  },
});

const issueRefund = tool({
  name: 'issue_refund',
  description: 'Refund a payment to the caller. Requires human approval.',
  parameters: z.object({ orderId: z.string(), amountUsd: z.number().max(500) }),
  strategy: 'humanInTheLoop', // pauses until approveTool()/rejectTool()
  approvalTimeoutMs: 60_000,
  backgroundAudio: 'elevator-jazz',
  execute: async ({ orderId, amountUsd }) => ({ refunded: true, orderId, amountUsd }),
});

// ---- agents ----------------------------------------------------------------

const billingAgent = new Agent({
  name: 'Billing',
  id: 'billing',
  instructions:
    'You are the billing specialist. Handle invoices, payments, and refunds. Short phone sentences.',
  handoffDescription: 'Transfer for anything about invoices, payments, or refunds.',
  tools: [issueRefund],
});

const receptionist = new Agent({
  name: 'Receptionist',
  id: 'receptionist',
  instructions:
    'You answer the phone for Acme. Greet warmly, find out what the caller needs, ' +
    'and either help directly or transfer to billing. Speak in one or two short sentences.',
  voice: 'marin',
  tools: [lookupOrder, sendConfirmationSms],
  handoffs: [billingAgent],
});

// ---- bridge ----------------------------------------------------------------

const bridge = new TwilioRealtimeBridge({
  agent: receptionist,
  provider: openaiRealtime({
    // apiKey defaults to process.env.OPENAI_API_KEY
    model: 'gpt-realtime',
    vad: { type: 'server', silenceDurationMs: 700 },
    transcription: { language: 'en' },
  }),
  session: {
    greeting: { mode: 'agent-initiates' },
    interruptions: {
      enabled: true,
      guardDurationMs: 1500,
      rateLimit: {
        windowMs: 30_000,
        threshold: 4,
        instruction:
          'There is a lot of background noise. Ask the caller to move somewhere quieter.',
      },
    },
    idle: {
      timeoutSeconds: 12,
      prompts: ['The caller went quiet — gently ask if they are still there.'],
      maxNudges: 2,
    },
    maxCallDurationSeconds: 600,
    toolBackgroundAudio: { spec: 'thinking-hum', volume: 0.35 },
  },
  // Enables clean REST hangup + call transfer:
  ...(process.env.TWILIO_ACCOUNT_SID
    ? {
        twilio: {
          accountSid: process.env.TWILIO_ACCOUNT_SID!,
          authToken: process.env.TWILIO_AUTH_TOKEN!,
        },
      }
    : {}),
  builtinTools: {
    finishCall: true,
    transferCall: process.env.TRANSFER_NUMBER
      ? { enabled: true, defaultPhoneNumber: process.env.TRANSFER_NUMBER }
      : false,
  },
  logger: consoleLogger(),
});

// Observe everything:
bridge.on('session.started', (session: any) => {
  console.log(`📞 call started ${session.callSid}`);
  session.on('transcript.user', (e: any) => console.log(`   caller: ${e.text}`));
  session.on('transcript.agent', (e: any) => console.log(`   agent(${e.agentId}): ${e.text}`));
  session.on('agent.handoff', ({ from, to }: any) => console.log(`   ↪ handoff ${from.id} → ${to.id}`));
  session.on('playback.interrupted', ({ playedMs }: any) =>
    console.log(`   ✋ caller barged in at ${Math.round(playedMs)}ms`),
  );
  session.on('tool.approval.required', (req: any) => {
    console.log(`   ⚠️ approval needed: ${req.toolName}(${JSON.stringify(req.input)})`);
    console.log(`      approve with: session.approveTool('${req.approvalId}')`);
    // Demo: auto-approve after 3 seconds. Wire this to your ops console.
    setTimeout(() => session.approveTool(req.approvalId), 3000);
  });
  session.on('call.ended', ({ reason, durationMs, usage }: any) =>
    console.log(
      `📴 call ended (${reason}) after ${Math.round(durationMs / 1000)}s — ${usage.totalTokens} tokens`,
    ),
  );
});

// ---- HTTP ------------------------------------------------------------------

const app = Fastify();
await app.register(websocket);
await app.register(formbody);

/** Twilio Voice webhook (inbound calls) and outbound TwiML endpoint. */
app.post('/twilio/voice', async (_request, reply) => {
  return reply.type('text/xml').send(
    connectStreamTwiml({
      wsUrl: `${PUBLIC_WS_URL}/twilio/media-stream`,
      // Anything here arrives in start.customParameters (validateConnection
      // is the place to check a signed token).
      parameters: { source: 'example' },
    }),
  );
});

/** Media stream WebSocket — the bridge takes over from here. */
app.register(async (instance) => {
  instance.get('/twilio/media-stream', { websocket: true }, (socket) => {
    bridge.handleConnection(socket);
  });
});

/** Status callback: tells the bridge when an outbound callee picks up. */
app.post('/twilio/status', async (request, reply) => {
  const body = request.body as Record<string, string>;
  if (body.CallStatus === 'in-progress' || body.CallStatus === 'answered') {
    bridge.notifyAnswered(body.CallSid);
  }
  return reply.send('ok');
});

app.get('/health', async () => ({ ok: true, activeCalls: bridge.sessions().size }));

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`listening on :${PORT} — point Twilio at POST ${PUBLIC_WS_URL.replace('wss', 'https')}/twilio/voice`);
