---
'realtime-voice-agents': patch
---

GPT-Live: a parallel tool batch continues the backend once, after its last result.

The delegation backend issues parallel function calls in one response, and the server refuses a `response.create` while any call of that response is unanswered (`function_call_outputs_required`). On a decoupled backend the engine delivers each result the moment it is ready, with `triggerResponse` set, so the provider sent a continuation after every one: in the field (Oct 2026) ten parallel lookups drew nine refusals, and only the last continuation went through. The provider now tracks the calls still waiting for an output and whether a backend response is running (a delegation's or its own continuation), and sends one `response.create` once no call is open and the response that issued them has finished — a single continuation covers the whole batch. A result that lands after its response completed is still continued at once, and a result sent with `triggerResponse: false` (a handoff) still never continues the backend.

`FakeGptLiveServer` (`/testing`) now refuses a `response.create` while a call it issued has no output, with the real error's shape, and `sendParallelFunctionCalls` issues several calls from one backend response. Tests that wait for the continuation must first complete the response that issued the call (`sendBackendCompleted`), as the real wire does.
