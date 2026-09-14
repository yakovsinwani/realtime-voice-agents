# realtime-voice-agents

## 2.5.2

### Patch Changes

- cc21697: GPT-Live: a playout lead removes jitter-induced choppiness.

  The Live model streams at exactly real-time pace, so Twilio's outbound buffer never runs ahead of playout and every delivery hiccup between OpenAI, your server and Twilio was an audible gap (unlike Realtime, whose faster-than-real-time generation keeps seconds of cushion at Twilio). The provider now holds the first 200 ms of each utterance — the last idle delta included, so soft onsets are no longer clipped at the speech gate — then flushes and streams through, keeping Twilio that far ahead. `gptLive({ playoutLeadMs })` tunes it; `0` restores the previous forward-as-it-arrives behavior. Cost: ~200 ms on the first word of each agent turn.

## 2.5.1

### Patch Changes

- c218463: GPT-Live: handoffs no longer cut the voice mid-sentence, hold audio actually covers the reopen, and a cut utterance can no longer wedge playback.

  - On providers with `turnTaking: 'model'` a backend transfer lands while the voice is still speaking the sentence that announces it, and the handoff is a close-and-reopen. The bridge now holds the handoff until that utterance has played out plus one sentence gap (a new utterance cancels it; capped at 5 s so a voice that never stops still hands off). Before: "one moment, transferring y—" and dead air (field, Sept 2026).
  - `session.handoffHold` now plays on GPT-Live: the in-flight deltas of the sentence being cut used to kill the hold during its start delay, so it never started.
  - Closing a provider session for a handoff or reconnect abandons its open playback tracks (`PlaybackTracker.abandonOpen`). An utterance cut by the close never got its final mark, which left `isPlaybackActive()` true for the rest of the call — the hangup grace never armed and calls ended only by the 7 s watchdog (11 s of dead air after the goodbye); a REST transfer would have waited forever.
  - `deafness.ignoreUserAudioUntilFirstTurnDone` is now unset by default and resolves per provider: true where the bridge owns barge-in, false with `greeting.mode: 'user-initiates'` and on full-duplex providers (the model owns talk-over; "deaf" there only fed it silence). An explicit value is honored as written.

## 2.5.0

### Minor Changes

- 42d78f5: feat: GPT-Live provider (`realtime-voice-agents/gpt-live`) — OpenAI's full-duplex Live API.

  `gptLive({ voice, delegation: { model, instructions } })` bridges Twilio Media Streams to `gpt-live-1` over the Live WebSocket (`/v1/live/sessions`): native μ-law 8 kHz both ways, tools declared on the backend Responses model and executed by the bridge (results go straight back — the voice keeps talking while the backend works), greetings / nudges / goodbyes delivered as `session.commentary.append`, keypad entries and deferred results as `session.thinking.append`, and graceful teardown that waits for `session.closed` so the final usage is confirmed.

  Engine changes for full-duplex providers (all additive, capability-gated):

  - `ProviderCapabilities.turnTaking: 'model'` — the bridge never cancels, clears or truncates; the interruption guard is observe-only, `session.interrupt()` / `updateVad()` are documented no-ops, and deafness options feed silence instead of dropping frames (the model's session clock runs on input audio).
  - `ProviderCapabilities.startupHistory` + `ProviderSessionInit.history` — reconnects and handoff-reconnects seed the attributed transcript at session start instead of re-injecting it as text.
  - `ProviderCapabilities.decoupledBackend` — tool results and deferred injections bypass the after-playback queue; usage arrives from the provider's `usage` events.
  - `ProviderUsage.audioSeconds` / `UsageInfo.audioSeconds` — a running duration total for per-second-billed providers.
  - `FakeGptLiveServer` in `realtime-voice-agents/testing` (speech + closing silence, timed transcripts, backend function calls, usage ticks, server-side closes).

  Fixes surfaced by the field test (all providers):

  - `TypedEmitter.removeAllListeners()` with no argument now detaches every listener (Node treats an explicit `undefined` as an event name, so a detached provider kept reaching the session — e.g. a `usage.updated` after `call.ended`).
  - `call.ended.reason` is `agent-hangup` when Twilio's `stop` confirms our own REST completion (it raced the REST callback and was reported as `caller-hangup`).

## 2.4.0

### Minor Changes

- 69fcead: Make multi-agent transfer loops structurally impossible, and replay history with attribution.

  Two changes to how an agent receives control:

  - **An agent that just took over cannot transfer again until the caller speaks.** The `transfer_to_<id>` call is refused with a tool result explaining why (so the model does not simply retry it), the active agent does not change, and the new `agent.handoff.blocked` session event fires instead of `agent.handoff`. A caller turn — speech, a user transcript, or a keypad entry — unlocks transfers again. `session.handoffTo()` is host intent and bypasses the lock, but still arms it for the agent it installs. Trade-off: a pure router node now costs an extra caller turn, so direct arcs between agents beat hub-and-spoke.
  - **Replayed history is attributed.** The transcript re-injected after a handoff-reconnect or a provider reconnect now names the agent that said each line and interleaves completed transfers as `[transfer] A -> B (reason: …)` lines. A flat `Agent:` replay made every incoming agent re-derive intent from the same text, decide the request belonged to somebody else, and pass it on.

  `CallSnapshot.handoffHistory` entries gained an optional `reason`.

## 2.3.0

### Minor Changes

- c788c32: Add opt-in keypad (DTMF) input (`session.keypad`): keypresses are collected into complete entries — `#` submits, `*` clears, `maxDigits` auto-submits, an inter-digit timeout (4s) flushes a partial entry — each keypress stops the agent mid-sentence, and every entry is injected as a `[keypad] ...` **user** turn that triggers the model's answer (role `user`, not `system`: a trailing system item is skipped by the response it triggers — field-tested on xAI). A short note appended to the agent instructions (also after handoffs) tells the model what `[keypad]` messages are. Set `{}` to enable with defaults; every piece is overridable (`message`/`clearMessage`/`instructions` accept `false`, `interruptOnKeypress: false`, custom keys). Unset = raw `dtmf` events only, exactly as before.

  New public API: session option `keypad` (`KeypadOptions`), session events `keypad.entry` / `keypad.cleared`, the `session.keypad` handle (`digits`, `clear()`, `submit()` — the collector consumes a key before the raw `dtmf` event fires, so a `dtmf` listener can claim a key with `clear()`), and `KeypadCollector` / `defaultKeypadMessage` / `DEFAULT_KEYPAD_*` exports for custom wiring.

## 2.2.0

### Minor Changes

- 86bc1ce: Provider fallback chain: pass `fallbacks: [xaiRealtime(), geminiLive()]` alongside `provider` and the bridge tries them in order when the primary fails to come up at call start — a missing API key, an expired/revoked key (HTTP 401), exhausted credits/quota (403/429), a provider internal error (5xx / dropped socket), or a connect timeout. Each advance emits the new `provider.fallback` session event (`{ from, to, error }`); the call fails only when the whole chain is exhausted. Connect-time only by design — once a provider answers, the call stays with it.

  To let a chain absorb a missing key, `openaiRealtime` / `xaiRealtime` / `geminiLive` now resolve credentials per call instead of throwing while the config is built: with no key and no fallbacks, the first call fails with the same clear error that used to throw at startup.

  `FakeOpenAIServer` gains `refuseConnections` (down provider) and `rejectUpgrade` (HTTP 401/403/5xx auth-style rejection) options, both mutable at runtime, plus matching counters, for scripting these scenarios in tests.

## 2.1.0

### Minor Changes

- 9665c74: Add opt-in noise-adaptive VAD (`session.noiseAdaptiveVad`): a per-frame μ-law noise-floor meter on inbound caller audio escalates turn detection mid-call when the line is persistently noisy. Server-VAD `threshold` steps up via ack-gated `session.update` (default one step per call, escalate-only, cooldown between steps); semantic VAD and Gemini receive `vad.suggestion` events instead of automatic changes. Baselines come from each provider's declared `capabilities.vadTuning` profile (OpenAI 0.5, xAI 0.85) or the configured threshold — never guessed. Caller speech, agent playback, and the pre-synthesized greeting are excluded from the floor estimate, so a long monologue in a quiet room never escalates.

  New public API: `session.updateVad(vad)` (persists across reconnects/handoffs, rebases the adaptive ladder; `null` disables turn detection and adaptation), session events `vad.suggestion`/`vad.adjusted`, `NoiseAdaptiveVadController`, and `NoiseFloorEstimator`/`mulawFrameDbfs` in `realtime-voice-agents/audio`.

  Ships with supporting changes:

  - Bug fix (applies regardless of the feature): `updateSession({ vad })` now re-applies the bridge-owned `interrupt_response: false` injection — previously a mid-call vad patch silently re-enabled server-side auto-interrupt, breaking guarded barge-ins.
  - Opt-in serialized session updates: with `noiseAdaptiveVad` configured, every mid-call `session.update` for that session is sent one at a time with snapshot payloads and waits for its `session.updated` ack (timeout ⇒ reconnect into known-good state). Without the feature, updates keep the fire-and-forget behavior exactly as before.
  - Provider interface additions for custom `BaseRealtimeProvider` implementations: `updateSession(patch, { awaitAck? })` now returns `Promise<boolean | void>` (`true` = acknowledged), `getEffectiveVad()`, `ProviderSessionInit.serializedSessionUpdates`, and optional `capabilities.vadTuning`.

## 2.0.1

### Patch Changes

- a9be1d1: Point `repository`, `bugs`, and the README CI badge at the renamed GitHub
  repository (`yakovsinwani/realtime-voice-agents`). Metadata only — no code
  change; this ships so the npm page links to the repo directly instead of
  relying on GitHub's redirect from the old name.

## 2.0.0

### Major Changes

- ca56e40: Renamed the package from `twilio-realtime-agents` to `realtime-voice-agents`.

  No API changes — every export, subpath, option, and event is identical. The
  only migration is the specifier:

  ```diff
  -import { Agent, TwilioRealtimeBridge } from 'twilio-realtime-agents';
  -import { openaiRealtime } from 'twilio-realtime-agents/openai';
  +import { Agent, TwilioRealtimeBridge } from 'realtime-voice-agents';
  +import { openaiRealtime } from 'realtime-voice-agents/openai';
  ```

  ```bash
  npm uninstall twilio-realtime-agents && npm install realtime-voice-agents
  ```

  `twilio-realtime-agents` is deprecated on npm at 1.2.0 and receives no further
  releases. The `twilio-` prefix implied an official Twilio package, which this
  has never been — it is an independent MIT project, not affiliated with Twilio,
  OpenAI, xAI, or Google.

## 1.2.0

### Minor Changes

- d38469d: **Behavior change**: `deafness.ignoreUserAudioUntilFirstTurnDone` now defaults to `true` — caller audio is dropped until the agent's first turn finishes playing, protecting the greeting from noisy pickups. With `greeting.mode: 'user-initiates'` the default stays `false` (the caller must be heard to start the call); an explicit setting is honored either way. A played pre-synthesized greeting and a silent first response (no audio, no tool work) now count as the first turn, so the deafness window always closes. Set `deafness: { ignoreUserAudioUntilFirstTurnDone: false }` to restore the previous behavior.
- d38469d: Add `deafness.muteWhileAgentSpeaking`: drop caller audio while agent audio is audibly playing (half-duplex mode for extreme-noise environments). Caller speech during agent playback is lost, not queued — prefer `interruptions.enabled: false` when blocked speech should still be answered afterwards. Default false.
- d7e89d4: Simpler configuration:

  - **Removed** `interruptions.preventInterruptionOnFirstSentence`. It lifted when the first sentence finished _generating_ (transcript text), which happens well before the caller hears it — use `deafness.ignoreUserAudioUntilFirstTurnDone` (playback-truth based) or `guardDurationMs` instead.
  - Provider factories now auto-detect API keys from common env var aliases when no explicit `apiKey` is passed (explicit keys always win): OpenAI `OPENAI_API_KEY`/`OPENAI_KEY`/`OPEN_AI_API_KEY`, xAI `XAI_API_KEY`/`GROK_API_KEY`/`XAI_KEY`, Gemini `GOOGLE_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_GENAI_API_KEY`. The lists are exported as `*_KEY_ENV_VARS` constants.

## 1.1.3

### Patch Changes

- 3dd1185: Three hardening fixes from field testing:

  - HTTP-rejected WebSocket upgrades (401 bad key, 403 no credits, 404 bad path) now fail the connect with the provider's actual status and response body instead of a bare close code 1006 — xAI's "team has no credits" verdict was previously invisible.
  - Event maps no longer carry a string index signature, so a misspelled event name (`session.on("tool.succeeded", ...)` — the real event is `tool.completed`) is now a compile-time error instead of a listener that silently never fires. If your build breaks on an event name after upgrading, the listener was never firing to begin with.
  - The interruption guard is no longer disarmed by a response that starts while the guarded response's audio is still playing (the server auto-answers a guard-blocked caller turn as soon as generation — not playback — finishes; with `firstResponseOnly` that phantom response burned the guard mid-greeting). Guard rotation now defers until the guarded playback actually ends.

- 9ce2a9f: Gemini Live setup failures no longer crash the host process. When the server refuses a session during setup (e.g. close 1007 for an unsupported config), both the SDK's connect promise and the provider's internal setup promise reject; the rejection `connect()` did not rethrow escaped as a process-killing unhandledRejection. Both rejections are now always observed, and `connect()` surfaces the server's close code and reason instead of the SDK's generic connect failure.

## 1.1.2

### Patch Changes

- 026cd57: Never truncate a live goodbye: the hangup watchdog is now evidence-based. Previously `finish_call` armed a fixed one-shot timer (`hangup.markTimeoutMs`, 7s) that force-completed the hangup even while the farewell was still being generated or audibly playing — a slow goodbye generation plus a longish farewell was cut off mid-sentence, on every provider. The watchdog now re-arms whenever goodbye progress arrives (audio deltas forwarded, the goodbye response starting, mark echoes coming home) and forces completion only after a full `markTimeoutMs` window with no evidence at all. Dead sockets and models that never say goodbye still complete within one or two quiet windows.

## 1.1.1

### Patch Changes

- 0955107: Two field fixes from live xAI (Grok Voice) calls:

  - Barge-ins no longer send `response.cancel` on providers without `vadInterruptControl` (xAI/Gemini) — their servers already cancelled on speech onset, so the bridge's cancel always raced and surfaced as a spurious session `error`. xAI's benign cancel-race shape (generic `invalid_request_error` code with a "Cancellation failed: no active response" message) is now also classified as benign, matching OpenAI's `response_cancel_not_active` handling.
  - A caller talking over the goodbye now completes the hangup immediately: the flushed farewell's playout can never confirm, so waiting on the 7s watchdog just produced dead air at the end of the call.

## 1.1.0

### Minor Changes

- 192741d: The interruption guard now genuinely prevents interruptions. Previously OpenAI's server VAD auto-cancelled the active response on speech onset (`interrupt_response` defaults to true), so a guard-blocked barge-in still killed the sentence mid-air — the guard only stopped the Twilio buffer clear, leaving the tail of the sentence never generated and the next response queued behind stale audio.

  Now the bridge owns barge-in end to end on providers that support it:

  - New `ProviderCapabilities.vadInterruptControl` (OpenAI: on; xAI/Gemini: off — `interrupt_response` is not documented for them; their fallback is asserted in parity tests).
  - `CallSession` asks providers to disable server-side auto-interrupt (`interrupt_response: false`); an explicit `vad.interruptResponse` still wins. `VadConfig` gains normalized `interruptResponse` / `createResponse` fields.
  - When the guard ALLOWS a barge-in, the bridge itself sends `response.cancel`, clears Twilio, and truncates. Deltas already in flight for a cancelled response are dropped instead of queuing stale speech behind the clear.
  - When the guard BLOCKS, nothing is cancelled — the agent keeps talking — and the caller's swallowed turn (which the server no longer auto-answers while a response is active) is answered once protected playback finishes.

### Patch Changes

- b060256: Interleave Twilio playback marks at checkpoints instead of after every audio delta. Field testing (A/B with marks disabled) showed that doubling the message count on the Twilio media socket audibly degrades playback smoothness. Marks now go out after the first chunk of a response (exact `playback.started`), every ~1s of audio, and after the final chunk when generation completes (exact `playback.finished`) — cutting mark traffic ~90% on long responses. `PlaybackTracker.onAudioSent` now returns `string | null`, and `onGenerationDone` returns the final tail mark to send (`string | null`); truncate estimates between echoes rely on the existing wall-clock interpolation, so barge-in accuracy is bounded by echo jitter, not the checkpoint interval.

## 1.0.1

### Patch Changes

- c81ff9c: Fix a host-process crash on `conversation_already_has_active_response` and reduce audio stutter on the OpenAI/xAI path.

  - **`response.create` is now serialized per session.** Creates requested while a response is in flight wait in a coalescing pending slot and fire on `response.done` (explicit instructions survive later bare triggers). Flushing the tool-result queue now sends one `response.create` for all drained results instead of one per result — the pattern that made the GA API reject the call mid-conversation.
  - **Benign protocol races no longer crash the host.** `conversation_already_has_active_response` (our create lost a race to a VAD-created response) is logged, and the rejected create is re-armed to fire when the active response completes; `response_cancel_not_active` is logged and ignored. Genuinely fatal provider errors still emit `error` — but an unhandled `'error'` event on any package emitter no longer throws (Node otherwise kills the process); `CallSession` logs the error when no listener is attached.
  - **`permessage-deflate` is disabled on the provider WebSocket.** Every audio delta was being inflated through ws's async zlib queue, adding per-chunk latency jitter to playback for no meaningful bandwidth gain on base64 μ-law.

## 1.0.0

### Major Changes

- df48714: Initial release: provider-agnostic bridge between Twilio Media Streams and realtime speech-to-speech AI (OpenAI Realtime GA, xAI Grok Voice, Gemini Live).

  - One `Agent` / `tool()` (Zod) / session API across providers, with capability-based behavior (no provider name checks)
  - Mark-based playback tracking: `playback.started/finished/interrupted` reflect what the caller actually heard
  - True barge-in: Twilio buffer flush + `conversation.item.truncate` with heard-milliseconds; guard windows (duration / first-sentence) and a noisy-environment rate limiter
  - Tool execution strategies: `sync`, `dispatch`, `deferred` (host-completable), `humanInTheLoop` (approve/reject/timeout) + cross-cutting middleware onion
  - Swarm multi-agent handoffs via generated `transfer_to_<id>` tools (session.update on OpenAI/xAI, reconnect + context carry on Gemini)
  - Graceful goodbye-aware hangup with watchdog; announced REST call transfer (validated + XML-escaped)
  - Background/hold audio engine with five synthesized μ-law presets, drift-corrected pacing, refcounting, and instant speech preemption
  - Pre-synthesized greeting burst-write (~1.5s to first word) with three-layer no-re-greet and `captureGreetingAudio()`
  - Idle nudge escalation, max-duration watchdog, DTMF events, usage accumulation, snapshot store
  - Provider reconnect with backoff + jitter, transcript re-injection, Gemini session resumption and goAway handling
  - `twilio-realtime-agents/testing`: FakeTwilioMediaStream (exact mark/clear playout semantics), FakeOpenAIServer, FakeGeminiLive
