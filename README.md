# realtime-voice-agents

[![npm version](https://img.shields.io/npm/v/realtime-voice-agents)](https://www.npmjs.com/package/realtime-voice-agents)
[![CI](https://github.com/yakovsinwani/realtime-voice-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/yakovsinwani/realtime-voice-agents/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/realtime-voice-agents)](https://www.npmjs.com/package/realtime-voice-agents)
[![license](https://img.shields.io/npm/l/realtime-voice-agents)](LICENSE)

**Provider-agnostic bridge between Twilio Media Streams and realtime speech-to-speech AI.** Build phone voice agents in Node.js with one `Agent` / `tool()` / session API across **OpenAI Realtime**, **OpenAI GPT-Live** (full-duplex), **xAI Grok Voice**, and **Gemini Live** — with multi-agent handoffs, tool execution strategies, hardware-confirmed playback tracking, true barge-in, and hold audio.

```
 Caller ── PSTN ── Twilio ── Media Stream WS ──▶ TwilioRealtimeBridge ──▶ OpenAI Realtime / GPT-Live / xAI / Gemini
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
npm install realtime-voice-agents zod
# optional, per feature:
npm install twilio         # REST hangup/transfer/SMS
npm install @google/genai  # Gemini Live provider
```

Node 20+. Zod 3.25+ or 4.

> Previously published as `twilio-realtime-agents` (through 1.2.0, now deprecated). v2 is the same package under the new name — no API changes, only the import specifier. Swap the dependency and update your imports.

## Quick start

```ts
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import * as z from 'zod';
import { Agent, TwilioRealtimeBridge, connectStreamTwiml, tool } from 'realtime-voice-agents';
import { openaiRealtime } from 'realtime-voice-agents/openai';

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
import { openaiRealtime } from 'realtime-voice-agents/openai';
import { gptLive } from 'realtime-voice-agents/gpt-live';
import { xaiRealtime } from 'realtime-voice-agents/xai';
import { geminiLive } from 'realtime-voice-agents/gemini';

openaiRealtime({
  model: 'gpt-realtime',
  voice: 'marin',
  vad: { type: 'server', silenceDurationMs: 700 },
});
gptLive({
  voice: 'marin',
  delegation: { model: 'gpt-5.6-terra', instructions: 'Backend procedures and tool rules.' },
});
xaiRealtime({ model: 'grok-voice-latest', voice: 'eve' });
geminiLive({ model: 'gemini-2.5-flash-native-audio-preview-12-2025', voice: 'Aoede' });
// or bring your own: implement BaseRealtimeProvider and pass a factory.
```

|                        | OpenAI Realtime                   | GPT-Live                                    | xAI                               | Gemini Live                            |
| ---------------------- | --------------------------------- | ------------------------------------------- | --------------------------------- | -------------------------------------- |
| Audio path             | μ-law passthrough                 | μ-law passthrough (continuous stream)       | μ-law passthrough                 | transcoded (stateful resampler)        |
| Turn-taking / barge-in | bridge-owned (guards, truncate)   | model-owned (full-duplex; guards observe)   | server VAD, buffer flush only     | server self-truncates                  |
| Tools run on           | the voice model                   | a backend Responses model (voice keeps talking) | the voice model               | the voice model                        |
| Mid-session agent swap | ✅ `session.update`               | reconnect + history seeded via `session.input` | ✅ `session.update`            | reconnect + context carry              |
| Session resumption     | —                                 | —                                           | —                                 | ✅ handles, replayed on reconnect      |
| Reconnect              | backoff + transcript re-injection | backoff + seeded history                    | backoff + transcript re-injection | backoff + resumption (or re-injection) |

One `SessionOptions` surface configures all four; where a provider can't honor a knob, the fallback is documented and pinned by the parity test suite.

### GPT-Live: full-duplex, two prompts

[GPT-Live](https://developers.openai.com/api/docs/guides/live) is a different API from Realtime (`/v1/live/sessions`), not a new Realtime model. The voice model listens while it speaks and decides on its own when to answer and when to stop; a **backend** Responses model does the reasoning and calls your tools while the conversation keeps going. The bridge translates that into the same `Agent` / `tool()` surface, with these differences:

- **Two prompts.** `Agent.instructions` is the *voice* prompt (style, backchannel and interruption policy, when to delegate). `gptLive({ delegation: { instructions } })` is the *backend* prompt (procedures, tool rules). Per-agent backend overrides go through `providerOptions: { delegation: { responses: { ... } } }`.
- **Barge-in is the model's.** `interruptions`, `vad`, `noiseAdaptiveVad`, `session.interrupt()` and `updateVad()` become documented no-ops: nothing is cancelled, cleared or truncated, and `user.speech.*` events are not emitted (the wire has no VAD events). Protect a greeting through the voice prompt ("finish the opening sentence before yielding").
- **Tools never pause the voice.** Results are delivered the moment they are ready regardless of `toolResultDelivery`; an interruption does not cancel a running tool, and its result still reaches the backend. Results are relayed in the model's own words — use exact wording only through the voice prompt.
- **Greetings, nudges and goodbyes** (`greeting.instructions`, `idle.prompts`, `finish_call`) are delivered as `session.commentary.append` — the append that reliably produces speech on demand. Keypad entries and deferred results are `session.thinking.append`; runtime instructions are `session.instructions.append`. Each append is capped at 500 tokens (long texts are split).
- **Immutable session.** Instructions, voice and audio format cannot change after start, so handoffs and reconnects open a fresh session and seed the attributed transcript through `session.input` (≤ 128 messages) — the anti-loop replay is preserved. Sessions expire after 120 minutes; an expiry reconnects the same way.
- **Transfers wait for the sentence.** A handoff here is a close-and-reopen, and the backend's transfer lands while the voice is still announcing it — the bridge holds the handoff until that utterance has played out (plus one sentence gap, capped at 8 s), so nothing is cut mid-word and `session.handoffHold` audio covers the reopen. Prompt the voice to *delegate first, announce after*: a transfer or tool the voice announces without delegating never happens.
- **Deafness feeds silence.** The model's session clock runs on input audio, so `deafness` options replace caller audio with silence instead of dropping frames. `ignoreUserAudioUntilFirstTurnDone` therefore defaults to **off** here — the model handles talk-over itself; set it explicitly to keep the greeting deaf.
- **Real-time stream, 200 ms of cushion.** The voice arrives at exactly real-time pace, so Twilio's buffer never runs ahead of playout and every delivery hiccup between OpenAI, your server and Twilio would be an audible gap (Realtime generates faster than real time, so it never has this problem). The provider holds the first 200 ms of each utterance — the last idle delta included, so soft onsets are not clipped — then streams through. `gptLive({ playoutLeadMs })` tunes it, `0` disables; the cost is that much latency on each turn's first word.
- **Billing is per second** of session (plus backend tokens). `session.usage.audioSeconds` carries the running total; backend token usage is summed from `response.completed`. The provider sends `session.close` on teardown and waits for `session.closed`, so a hung-up call never keeps billing.

## Provider fallbacks

One bad API key, an exhausted quota, or a provider outage should not send your calls to dead air. Give the bridge backup providers and it tries them in order while the call is being established:

```ts
const bridge = new TwilioRealtimeBridge({
  agent,
  provider: openaiRealtime(), // primary
  fallbacks: [xaiRealtime(), geminiLive()], // tried in order if it fails to come up
});
```

- **Covers the real failure modes.** A missing API key (the factories defer their credential check to call time precisely so the chain can absorb it), an expired/revoked key (HTTP 401), exhausted credits/quota (403/429), a provider internal error (5xx or a dropped socket), and a hung endpoint (connect timeout) all walk the chain — anything that keeps a provider from coming up.
- **Connect-time only.** A dead provider is dropped and the next one is tried immediately — no backoff between attempts. Once a provider answers, the call stays with it: mid-call reconnects reuse the same provider (per the `session.reconnect` policy), and a mid-call death past that budget fails the call rather than switching voices mid-conversation.
- **Observable.** Each advance emits `provider.fallback` (`{ from, to, error }`) on the session — count these to alarm on a degraded primary.
- **Voices don't cross vendors.** Configure the voice per factory (`openaiRealtime({ voice: 'marin' })`, `xaiRealtime({ voice: 'eve' })`) rather than on the `Agent` — an OpenAI voice name would fail the xAI/Gemini connect and the chain would skip past a healthy provider.
- **Latency.** Each dead provider costs up to its `connectTimeoutMs` (default 10s) before the next is tried — set a tighter one on the primary if its endpoint tends to hang rather than refuse. A [pre-synthesized greeting](#pre-synthesized-greeting-15s-to-first-word) bursts onto the line before any handshake, so the caller hears a voice while the chain walks.

Testing it: `FakeOpenAIServer.start({ refuseConnections: true })` gives you a provider that is "down", and `{ rejectUpgrade: { status: 401, body: 'invalid_api_key' } }` one that rejects like a real auth/quota failure (both flippable at runtime to script recoveries) — see `src/bridge/fallback.test.ts` for ready-made scenarios.

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

**An agent that just took over cannot transfer again until the caller speaks.** The transfer tool is refused (`agent.handoff.blocked` fires, the model is told why, the active agent does not change); a caller turn — speech or a keypad entry — unlocks it. This makes transfer loops structurally impossible rather than merely discouraged: given the same replayed transcript, each incoming agent otherwise re-derives intent, decides the request is somebody else's, and passes it on. The trade-off is that a pure router node costs an extra caller turn, so direct arcs between agents beat hub-and-spoke. `session.handoffTo()` is host intent and bypasses the lock (it still arms it for the agent it installs).

The context an incoming agent receives is attributed, not flat: each replayed line names the agent that said it, and completed transfers appear as `[transfer] A -> B (reason: …)` lines — so it can see what was already answered and already routed.

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

## Noise-adaptive VAD (opt-in)

Server VAD tuned for quiet rooms misfires on noisy lines — street, car, speakerphone — as phantom barge-ins and chopped replies. `noiseAdaptiveVad` measures the line itself: a per-frame μ-law meter estimates the caller's noise floor (a low percentile over a sliding window, so speech doesn't read as noise), and when it stays high, the bridge escalates turn detection mid-call.

```ts
session: {
  vad: { type: 'server', threshold: 0.5 },
  noiseAdaptiveVad: {},                  // {} = defaults below
  // mode: 'auto',                       // 'suggest' = events only, you apply
  // noiseFloorDb: -45,                  // trigger floor, dBFS
  // windowMs: 5000, sustainMs: 3000,    // how much/how long analyzed audio
  // cooldownMs: 15_000, maxSteps: 1,    // escalation pacing (per call)
  // thresholdStep: 0.1, maxThreshold: 0.9,
}
```

How a step lands, per provider:

| Provider | Escalation |
| --- | --- |
| OpenAI | `threshold` +0.1/step, auto-applied via ack-gated `session.update`; baseline = your `vad.threshold`, else OpenAI's documented 0.5 |
| xAI | same, from xAI's documented **0.85** default, clamped to its 0.1–0.9 range |
| Gemini | `vad.suggestion` event only (`startSensitivity: 'low'` analog) — the Live API has no mid-session config updates |
| semantic VAD | `vad.suggestion` event only: `eagerness: 'low'` trades **end-of-turn latency** (waits up to ~8s) for stability, so that call is yours |

The baseline comes from the provider's ACKnowledged effective config plus its declared `capabilities.vadTuning` profile — never guessed (assuming 0.5 on xAI would *lower* its 0.85 default). Escalation is one-way per call: steps up, never back down; `maxSteps` and `cooldownMs` bound the blast radius.

Every decision emits `vad.suggestion` (recommended config + `noiseFloorDb`/`analyzedMs`/`elapsedMs` metrics); an applied-and-acknowledged step also emits `vad.adjusted`. In `mode: 'suggest'` nothing is applied automatically — accept with `session.updateVad(info.suggested)`, which persists across reconnects and rebases future escalation on top of it. `updateVad(null)` disables turn detection AND suspends adaptation (it never re-enables VAD by itself).

Fine print:

- Caller speech, agent playback (speakerphone bleed), and the pre-synthesized greeting are excluded from the floor estimate — a long monologue in a quiet room never escalates. `windowMs` counts **analyzed** idle-line audio, so warmup can span 30–60s of real conversation; the metrics exist to tune this from field data.
- Enabling the feature also serializes ALL mid-call session updates for that session: one in flight, acknowledged before the next; an ack timeout reconnects into known-good state. Disabled = the legacy fire-and-forget behavior, untouched.
- Complementary knobs: OpenAI's native `audio.input.noise_reduction` (reachable via the provider's `sessionOptions`) runs before VAD and may fix much of the problem upstream; `interruptions.rateLimit` reacts to barge-in churn after the fact, while this reacts to the audio itself. All three coexist.

## Pre-synthesized greeting (~1.5s to first word)

The slowest part of answering is the provider handshake. Pre-record the greeting once, and the bridge burst-writes it onto the call **while the session is still connecting** — then keeps the model from greeting twice (instruction reinforcement + assistant-turn seeding + suppressed auto-greet) and gates caller audio until Twilio's mark confirms playout.

```ts
import { captureGreetingAudio } from 'realtime-voice-agents';

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

## Keypad input (DTMF, opt-in)

Callers type an ID, a phone number, a confirmation code — Twilio delivers each key as its own `dtmf` frame, ~1s apart, and a model that sees ten fragments answers "I didn't get that" ten times. `keypad` turns keypresses into one entry: digits buffer, `#` submits, `*` clears, `maxDigits` auto-submits, 4s without a key flushes what's there (so the agent can say "that's only 7 digits — again, please"). Each keypress stops the agent mid-sentence (typing means "I'm answering"), and the entry reaches the model as a **user** turn — `[keypad] I typed on my phone keypad: 0541234567 — 10 digits. Digit by digit: 0 5 4 …` — that triggers the response answering it. A short note appended to the agent instructions tells the model what `[keypad]` messages are.

```ts
session: {
  keypad: {},                              // {} = defaults below
  // maxDigits: 9,                         // auto-submit at N digits (no # needed)
  // interDigitTimeoutMs: 4000, submitKey: '#', clearKey: '*',
  // interruptOnKeypress: true,            // false: the agent keeps talking while the caller types
  // message: (entry) => string | false,   // wording of the injected user turn; false = events only
  // clearMessage: string | false,         // what the model hears on *; false = nothing
  // instructions: string | false,         // the appended note; false = your prompt says it
}
```

Observe or take over with events and the `session.keypad` handle (`digits`, `clear()`, `submit()`):

```ts
session.on('keypad.entry', ({ digits, reason }) => { /* reason: 'submit' | 'timeout' | 'maxDigits' */ });
session.on('keypad.cleared', ({ discarded }) => { /* caller pressed * */ });
// Raw keypresses still fire per key — AFTER the collector consumed them, so the handle is current:
session.on('dtmf', ({ digit }) => {
  if (digit === '0' && session.keypad.digits === '0') { session.keypad.clear(); void session.transferTo(OPERATOR); }
});
```

`message: false` keeps the collection and events but injects nothing — validate the entry yourself and `session.sendText(..., { role: 'user', triggerResponse: true })` what the model should hear. Role `user`, not `system`: a trailing system item is skipped by the response it triggers and only lands one response later (field-tested on xAI). Without `keypad` configured nothing changes: raw `dtmf` events only, as before. Letters A–D are ignored; the buffer dies with the call.

## Events (session)

`call.started/ended/failed` · `provider.connected/fallback/reconnecting/reconnected/closed` · `agent.speech.started/ended` (generation) · **`playback.started/finished/interrupted`** (what the caller heard, mark-confirmed) · `user.speech.started/ended` · `transcript.user/agent` · `tool.started/completed/failed` · `tool.approval.required` · `agent.handoff` / `agent.handoff.blocked` · `interruption` / `interruption.blocked` · `vad.suggestion` / `vad.adjusted` (noise-adaptive VAD) · `background_audio.started/stopped` · `dtmf` (raw keypress) · `keypad.entry` / `keypad.cleared` (keypad input) · `usage.updated` · `error`.

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
  deafness: {
    ignoreUserAudioUntilFirstTurnDone: undefined, // auto: true, except false with greeting.mode 'user-initiates' and on full-duplex providers (GPT-Live)
    muteDuringToolExecution: true,
    muteWhileAgentSpeaking: false,              // half-duplex: deaf while agent audio plays (caller speech is lost, not queued)
  },
  idle: undefined,                              // { timeoutSeconds, prompts, maxNudges, goodbye }
  maxCallDurationSeconds: undefined,
  reconnect: { maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 8000, jitter: true },
  hangup: { markTimeoutMs: 7000 },              // goodbye watchdog
  vad: undefined,                               // normalized VAD, mapped per provider
  noiseAdaptiveVad: undefined,                  // opt-in noise → VAD escalation ({} enables; see its section)
  keypad: undefined,                            // opt-in DTMF → one user turn per entry ({} enables; see its section)
  toolResultDelivery: 'afterPlayback',          // or 'immediate'
  toolBackgroundAudio: undefined,               // default hold audio for tools
  handoffVoicePolicy: 'keep',                   // or 'reconnect' to switch voices
  handoffHold: undefined,                       // { spec: 'ringing', ... }: hold audio over a reconnect-style handoff (Gemini, GPT-Live)
  context: {},                                  // seed session KV for tools/instructions
}
```

Multi-tenant: `agent`, `session`, and `validateConnection` all accept per-call resolvers receiving the Twilio start frame (check a signed token from `<Parameter>`s there).

Outbound calls: the greeting waits for a human — feed your status callback into `bridge.notifyAnswered(callSid)`.

## Testing without phone calls

`realtime-voice-agents/testing` ships the harness this package is tested with:

- **`FakeTwilioMediaStream`** — a scripted caller with an exact playout simulation: marks echo only after the media before them "plays"; `clear` discards buffered audio and echoes pending marks, like real Twilio.
- **`FakeOpenAIServer`** — a real-WebSocket GA-protocol server you script (`sendAudioResponse`, `sendToolCall`, `sendSpeechStarted`, drops, `refuseConnections` for down-provider/fallback scenarios).
- **`FakeGptLiveServer`** — a real-WebSocket Live-protocol server: `sendSpeech` (speech chunks + the silence that closes the gate), timed transcripts, backend function calls in `response.event` envelopes, usage ticks, server-side closes.
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

`realtime-voice-agents` (core) · `/openai` · `/gpt-live` · `/xai` · `/gemini` · `/twilio` (wire types, TwiML, REST) · `/audio` (μ-law, resampler, transcoders, background player) · `/store` (SessionStore + in-memory) · `/testing`.

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
