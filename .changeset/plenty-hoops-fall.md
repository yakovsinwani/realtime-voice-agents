---
'realtime-voice-agents': minor
---

Provider fallback chain: pass `fallbacks: [xaiRealtime(), geminiLive()]` alongside `provider` and the bridge tries them in order when the primary fails to come up at call start (rejected key, exhausted quota, outage, connect timeout). Each advance emits the new `provider.fallback` session event (`{ from, to, error }`); the call fails only when the whole chain is exhausted. Connect-time only by design — once a provider answers, the call stays with it. `FakeOpenAIServer` gains a `refuseConnections` option (plus a `refusedConnections` counter) for scripting down-provider scenarios in tests.
