---
'realtime-voice-agents': minor
---

Provider fallback chain: pass `fallbacks: [xaiRealtime(), geminiLive()]` alongside `provider` and the bridge tries them in order when the primary fails to come up at call start — a missing API key, an expired/revoked key (HTTP 401), exhausted credits/quota (403/429), a provider internal error (5xx / dropped socket), or a connect timeout. Each advance emits the new `provider.fallback` session event (`{ from, to, error }`); the call fails only when the whole chain is exhausted. Connect-time only by design — once a provider answers, the call stays with it.

To let a chain absorb a missing key, `openaiRealtime` / `xaiRealtime` / `geminiLive` now resolve credentials per call instead of throwing while the config is built: with no key and no fallbacks, the first call fails with the same clear error that used to throw at startup.

`FakeOpenAIServer` gains `refuseConnections` (down provider) and `rejectUpgrade` (HTTP 401/403/5xx auth-style rejection) options, both mutable at runtime, plus matching counters, for scripting these scenarios in tests.
