# twilio-realtime-agents

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
