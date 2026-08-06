# twilio-realtime-agents

[![npm version](https://img.shields.io/npm/v/twilio-realtime-agents)](https://www.npmjs.com/package/twilio-realtime-agents)
[![CI](https://github.com/yakovsinwani/twilio-realtime-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/yakovsinwani/twilio-realtime-agents/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/twilio-realtime-agents)](https://www.npmjs.com/package/twilio-realtime-agents)
[![license](https://img.shields.io/npm/l/twilio-realtime-agents)](LICENSE)

**Provider-agnostic bridge between Twilio Media Streams and realtime speech-to-speech AI.** Build phone voice agents in Node.js with one `Agent` / `tool()` / session API across **OpenAI Realtime**, **xAI Grok Voice**, and **Gemini Live** — with multi-agent handoffs, tool execution strategies, hardware-confirmed playback tracking, true barge-in, and hold audio.

```
 Caller ── PSTN ── Twilio ── Media Stream WS ──▶ TwilioRealtimeBridge ──▶ OpenAI / xAI / Gemini
                                 μ-law 8kHz          CallSession              realtime S2S
```

## Why this exists

Bridging a phone call to a realtime model looks like "pipe two WebSockets together" — until you hit the real problems:

- **Twilio buffers seconds of audio.** Generation-side events run far ahead of what the caller hears. This SDK interleaves a **mark after every audio chunk**; Twilio echoes each mark when playout actually reaches it, giving you `playback.started` / `playback.finished` / `playback.interrupted` events that reflect the phone line, not the model.
- **Barge-in needs three things, not one.** On interruption we flush Twilio's buffer (`clear`), and on providers that support it send `conversation.item.truncate` with the _actually-heard_ milliseconds — so the model's memory of what it said matches reality.
- **Codecs differ.** OpenAI and xAI speak `audio/pcmu` natively → **zero transcoding**, byte-for-byte passthrough. Gemini speaks PCM (16k in / 24k out) → a stateful polyphase resampler with inter-chunk filter memory (no per-chunk boundary clicks).
- **Hangups cut off goodbyes.** `finish_call` uses a goodbye contract: the tool result _instructs_ the model to say farewell, marks confirm the farewell finished playing, then the leg completes via REST — with a watchdog if the echo never comes.
- **Slow tools sound like dead air.** Bundled μ-law hold loops (typing, hold music, ambient) start after a delay (fast tools stay silent), pace in near-realtime, and yield instantly when real speech arrives.

## Install

```bash
npm install twilio-realtime-agents zod
# optional, per feature:
npm install twilio         # REST hangup/transfer/SMS
npm install @google/genai  # Gemini Live provider
```

Node 20+. Zod 3.25+ or 4.

## Quick start

```ts
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import * as z from 'zod';
import { Agent, TwilioRealtimeBridge, connectStreamTwiml, tool } from 'twilio-realtime-agents';
import { openaiRealtime } from 'twilio-realtime-agents/openai';

const weather = tool({
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 22, sky: 'clear' }),
});

const bridge = new TwilioRealtimeBridge({
  agent: new Agent({
    name: 'Receptionist',
    instructions: 'Answer the phone briefly and warmly.',
    voice: 'marin',
    tools: [weather],
  }),
  provider: openaiRealtime(), // OPENAI_API_KEY from env
  builtinTools: { finishCall: true },
});

const app = Fastify();
await app.register(websocket);

app.post('/twilio/voice', async (_req, reply) =>
  reply.type('text/xml').send(connectStreamTwiml({ wsUrl: 'wss://your-host/twilio/media-stream' })),
);
app.register(async (i) => {
  i.get('/twilio/media-stream', { websocket: true }, (socket) => bridge.handleConnection(socket));
});

await app.listen({ port: 3000 });
```

Point your Twilio number's Voice webhook at `POST /twilio/voice`. That's a working agent. See [examples/fastify](examples/fastify) for the full tour (handoffs, strategies, approvals, outbound calls) and [examples/express-ws](examples/express-ws) for the minimal version.

## Providers

```ts
import { openaiRealtime } from 'twilio-realtime-agents/openai';
import { xaiRealtime } from 'twilio-realtime-agents/xai';
import { geminiLive } from 'twilio-realtime-agents/gemini';

openaiRealtime({
  model: 'gpt-realtime',
  voice: 'marin',
  vad: { type: 'server', silenceDurationMs: 700 },
});
xaiRealtime({ model: 'grok-voice-latest', voice: 'eve' });
geminiLive({ model: 'gemini-2.5-flash-native-audio-preview-12-2025', voice: 'Aoede' });
// or bring your own: implement BaseRealtimeProvider and pass a factory.
```

|                        | OpenAI                            | xAI                               | Gemini Live                            |
| ---------------------- | --------------------------------- | --------------------------------- | -------------------------------------- |
| Audio path             | μ-law passthrough                 | μ-law passthrough                 | transcoded (stateful resampler)        |
| Barge-in truncation    | ✅ `item.truncate`                | buffer flush only                 | server self-truncates                  |
| Mid-session agent swap | ✅ `session.update`               | ✅ `session.update`               | reconnect + context carry              |
| Session resumption     | —                                 | —                                 | ✅ handles, replayed on reconnect      |
| Reconnect              | backoff + transcript re-injection | backoff + transcript re-injection | backoff + resumption (or re-injection) |

One `SessionOptions` surface configures all three; where a provider can't honor a knob, the fallback is documented and pinned by the parity test suite.

## Tools: Zod schemas + execution strategies

```ts
tool({
  name: 'run_credit_check',
  description: 'Credit check across bureaus (slow).',
  parameters: z.object({ customerId: z.string() }),
  strategy: 'deferred', // ← how it executes relative to the conversation
  timeoutMs: 30_000,
  backgroundAudio: 'elevator-jazz', // hold audio while the caller waits (sync/HITL)
  onBeforeExecute: async (input) => {
    /* veto or rewrite input */
  },
  onAfterExecute: async (result) => {
    /* transform what the model sees */
  },
  onError: async (err) => ({ error: 'Bureau unavailable, offer a callback.' }),
  execute: async ({ customerId }, ctx) => creditApi.check(customerId),
});
```

| Strategy         | The model…                                                                                                                                           | Use for                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `sync` (default) | waits for the result (hold audio covers the gap)                                                                                                     | lookups, account data                 |
| `dispatch`       | gets `{status:'queued'}` instantly and keeps talking                                                                                                 | SMS, webhooks, analytics              |
| `deferred`       | acknowledges; the result is **injected as a new turn** when ready — from `execute()` or from your backend via `session.submitToolResult(id, result)` | slow third-party APIs                 |
| `humanInTheLoop` | waits while `tool.approval.required` fires; resolve with `session.approveTool(id, editedInput?)` / `rejectTool(id, reason)` (auto-reject on timeout) | refunds, deletions, high-risk actions |

**Tool context** gives every tool capability closures — never raw sockets: `ctx.session.sendText/finishCall/transferTo/handoffTo/playBackgroundAudio/submitToolResult`, `ctx.context` (session KV carried across handoffs), `ctx.callInfo`, `ctx.signal`.

**Cross-cutting middleware** (an onion, first registered = outermost; may short-circuit):

```ts
bridge.use({
  decorate: (tool) => ({ description: `${tool.description} (All actions are audited.)` }),
  wrapExecute: async (tool, input, ctx, next) => {
    audit.start(ctx.callSid, tool.name, input);
    try {
      return await next();
    } finally {
      audit.end(ctx.callSid, tool.name);
    }
  },
});
```

## Multi-agent handoffs (swarm)

```ts
const billing = new Agent({
  name: 'Billing',
  instructions: '…',
  handoffDescription: 'Transfer for invoices, payments, refunds.',
  tools: [issueRefund],
});
const receptionist = new Agent({ name: 'Receptionist', instructions: '…', handoffs: [billing] });
```

Each agent in `handoffs` becomes a `transfer_to_<id>` tool. On handoff the session settles the function call, swaps instructions + tools (`session.update` on OpenAI/xAI; close-and-reopen with context carry on Gemini), and triggers a natural continuation — the caller never hears a seam. Also available programmatically: `session.handoffTo('billing')`. Cycles are fine (billing can hand back).

## Built-in call controls

```ts
builtinTools: {
  finishCall: true,                                     // graceful goodbye-aware hangup
  transferCall: { enabled: true, defaultPhoneNumber: '+18005550199' }, // REST <Dial> transfer
},
twilio: { accountSid, authToken },                      // enables the REST control plane
```

`transfer_call` validates and XML-escapes numbers (never trust model output in markup), waits for current playback, and updates the live call's TwiML.

## Interruption control

```ts
session: {
  interruptions: {
    guardDurationMs: 1500,                 // no barge-in for the first 1.5s of each reply
    firstResponseOnly: false,
    rateLimit: {                           // noisy-environment defense
      windowMs: 30_000, threshold: 4,
      instruction: 'Ask the caller to move somewhere quieter.',
    },
  },
}
```

Blocked attempts emit `interruption.blocked` with a cause (`guard` | `rate_limit` | `tool_running` | …). Honored ones flush Twilio, truncate the model's context to the heard milliseconds, and emit `playback.interrupted` with exactly how much the caller heard.

## Pre-synthesized greeting (~1.5s to first word)

The slowest part of answering is the provider handshake. Pre-record the greeting once, and the bridge burst-writes it onto the call **while the session is still connecting** — then keeps the model from greeting twice (instruction reinforcement + assistant-turn seeding + suppressed auto-greet) and gates caller audio until Twilio's mark confirms playout.

```ts
import { captureGreetingAudio } from 'twilio-realtime-agents';

// once, at deploy/config time — records from a real session so the voice matches:
const { audio } = await captureGreetingAudio({
  apiKey: process.env.OPENAI_API_KEY!, voice: 'marin',
  text: 'Hi, thanks for calling Acme! How can I help?',
});

// per call:
session: { greeting: { mode: 'agent-initiates',
  preSynthesized: { audio, text: 'Hi, thanks for calling Acme! How can I help?' } } }
```

## Background / hold audio

Bundled presets (all synthesized, license-free, seamless loops): `elevator-jazz`, `lofi`, `keyboard-typing`, `thinking-hum`, `ringing` — or `{ custom: bufferOrPath }` with your own 8 kHz μ-law. Drift-corrected 20 ms pacing, refcounted across concurrent tools, ~1 s start delay so fast tools stay silent, fade in/out, 60 s failsafe, and instant preemption when real speech arrives. Manual control: `session.playBackgroundAudio('lofi')` / `stopBackgroundAudio()`.

## Events (session)

`call.started/ended/failed` · `provider.connected/reconnecting/reconnected/closed` · `agent.speech.started/ended` (generation) · **`playback.started/finished/interrupted`** (what the caller heard, mark-confirmed) · `user.speech.started/ended` · `transcript.user/agent` · `tool.started/completed/failed` · `tool.approval.required` · `agent.handoff` · `interruption` / `interruption.blocked` · `background_audio.started/stopped` · `dtmf` · `usage.updated` · `error`.

```ts
bridge.on('session.started', (session) => {
  session.on('playback.finished', ({ responseId, playedMs }) => {
    /* caller heard it all */
  });
  session.on('usage.updated', (usage) => console.log(usage.totalTokens));
});
```

## Session options (defaults shown)

```ts
session: {
  greeting: { mode: 'agent-initiates' },        // 'user-initiates' to wait
  interruptions: { enabled: true },
  deafness: { ignoreUserAudioUntilFirstTurnDone: false, muteDuringToolExecution: true },
  idle: undefined,                              // { timeoutSeconds, prompts, maxNudges, goodbye }
  maxCallDurationSeconds: undefined,
  reconnect: { maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 8000, jitter: true },
  hangup: { markTimeoutMs: 7000 },              // goodbye watchdog
  vad: undefined,                               // normalized VAD, mapped per provider
  toolResultDelivery: 'afterPlayback',          // or 'immediate'
  toolBackgroundAudio: undefined,               // default hold audio for tools
  handoffVoicePolicy: 'keep',                   // or 'reconnect' to switch voices
  context: {},                                  // seed session KV for tools/instructions
}
```

Multi-tenant: `agent`, `session`, and `validateConnection` all accept per-call resolvers receiving the Twilio start frame (check a signed token from `<Parameter>`s there).

Outbound calls: the greeting waits for a human — feed your status callback into `bridge.notifyAnswered(callSid)`.

## Testing without phone calls

`twilio-realtime-agents/testing` ships the harness this package is tested with:

- **`FakeTwilioMediaStream`** — a scripted caller with an exact playout simulation: marks echo only after the media before them "plays"; `clear` discards buffered audio and echoes pending marks, like real Twilio.
- **`FakeOpenAIServer`** — a real-WebSocket GA-protocol server you script (`sendAudioResponse`, `sendToolCall`, `sendSpeechStarted`, drops).
- **`FakeGeminiLive`** — a scripted `@google/genai` seam for the Gemini provider.

```ts
const server = await FakeOpenAIServer.start();
const bridge = new TwilioRealtimeBridge({
  agent,
  provider: openaiRealtime({ apiKey: 't', baseUrl: server.url }),
});
const caller = new FakeTwilioMediaStream();
bridge.handleConnection(caller);
caller.connect();
server.latest.sendAudioResponse({ chunks: [mulawSilenceBase64(200)], transcript: 'Hello!' });
caller.advancePlayback(200); // deterministic playout — assert on playback events
```

## Subpath exports

`twilio-realtime-agents` (core) · `/openai` · `/xai` · `/gemini` · `/twilio` (wire types, TwiML, REST) · `/audio` (μ-law, resampler, transcoders, background player) · `/store` (SessionStore + in-memory) · `/testing`.

## Observability & state

Every call checkpoint (start, handoffs, tool completions, end) snapshots to a `SessionStore` — transcript, usage, context KV, handoff history, Gemini resumption handle. `InMemorySessionStore` ships; the interface is three methods, so a Redis/Postgres store is a page of code.

## How this compares

An independent, MIT-licensed package — not affiliated with Twilio, OpenAI, xAI, or Google. Where it sits among the alternatives:

- **[Pipecat](https://github.com/pipecat-ai/pipecat)** — a Python-first framework for general realtime media pipelines: many transports (WebRTC, Daily, LiveKit, Twilio), cascading STT→LLM→TTS as well as speech-to-speech, and a large provider matrix. Reach for it if you work in Python or need transports beyond phone calls. This package is the TypeScript-native answer to one specific job — Twilio phone calls into speech-to-speech models — with a single runtime dependency (`ws`).
- **[LiveKit Agents](https://github.com/livekit/agents)** — agents run inside LiveKit's WebRTC infrastructure; phone calls enter via SIP into a LiveKit room. A strong production stack, at the cost of operating (or paying for) a media server between Twilio and your model. This package connects your Node.js server to Twilio Media Streams directly — no infrastructure in the middle.
- **[`@openai/agents-extensions`](https://www.npmjs.com/package/@openai/agents-extensions)** (`TwilioRealtimeTransportLayer`) — the official OpenAI transport for Twilio, OpenAI-only by design. If OpenAI Realtime is certain to be enough, it's a solid choice. This package keeps comparable ergonomics behind a provider seam (OpenAI, xAI, Gemini, or your own `BaseRealtimeProvider`) and adds mark-confirmed playback tracking, interruption guards, tool execution strategies, and hold audio.
- **A hand-rolled bridge** — Twilio's wire protocol is genuinely simple (~200 lines to pipe audio both ways). What remains is the hard 90%: playback truth while Twilio buffers seconds ahead of the phone, truncating the model's memory to the milliseconds actually heard, reconnects that carry context, tool-result timing, goodbye-aware hangups. Those problems are this package.

## License

MIT
