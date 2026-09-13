---
"realtime-voice-agents": minor
---

feat: GPT-Live provider (`realtime-voice-agents/gpt-live`) — OpenAI's full-duplex Live API.

`gptLive({ voice, delegation: { model, instructions } })` bridges Twilio Media Streams to `gpt-live-1` over the Live WebSocket (`/v1/live/sessions`): native μ-law 8 kHz both ways, tools declared on the backend Responses model and executed by the bridge (results go straight back — the voice keeps talking while the backend works), greetings / nudges / goodbyes delivered as `session.commentary.append`, keypad entries and deferred results as `session.thinking.append`, and graceful teardown that waits for `session.closed` so the final usage is confirmed.

Engine changes for full-duplex providers (all additive, capability-gated):

- `ProviderCapabilities.turnTaking: 'model'` — the bridge never cancels, clears or truncates; the interruption guard is observe-only, `session.interrupt()` / `updateVad()` are documented no-ops, and deafness options feed silence instead of dropping frames (the model's session clock runs on input audio).
- `ProviderCapabilities.startupHistory` + `ProviderSessionInit.history` — reconnects and handoff-reconnects seed the attributed transcript at session start instead of re-injecting it as text.
- `ProviderCapabilities.decoupledBackend` — tool results and deferred injections bypass the after-playback queue; usage arrives from the provider's `usage` events.
- `ProviderUsage.audioSeconds` / `UsageInfo.audioSeconds` — a running duration total for per-second-billed providers.
- `FakeGptLiveServer` in `realtime-voice-agents/testing` (speech + closing silence, timed transcripts, backend function calls, usage ticks, server-side closes).
