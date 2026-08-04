---
"twilio-realtime-agents": major
---

Initial release: provider-agnostic bridge between Twilio Media Streams and realtime speech-to-speech AI (OpenAI Realtime GA, xAI Grok Voice, Gemini Live).

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
