# twilio-realtime-agents

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
