---
"twilio-realtime-agents": minor
---

The interruption guard now genuinely prevents interruptions. Previously OpenAI's server VAD auto-cancelled the active response on speech onset (`interrupt_response` defaults to true), so a guard-blocked barge-in still killed the sentence mid-air — the guard only stopped the Twilio buffer clear, leaving the tail of the sentence never generated and the next response queued behind stale audio.

Now the bridge owns barge-in end to end on providers that support it:

- New `ProviderCapabilities.vadInterruptControl` (OpenAI: on; xAI/Gemini: off — `interrupt_response` is not documented for them; their fallback is asserted in parity tests).
- `CallSession` asks providers to disable server-side auto-interrupt (`interrupt_response: false`); an explicit `vad.interruptResponse` still wins. `VadConfig` gains normalized `interruptResponse` / `createResponse` fields.
- When the guard ALLOWS a barge-in, the bridge itself sends `response.cancel`, clears Twilio, and truncates. Deltas already in flight for a cancelled response are dropped instead of queuing stale speech behind the clear.
- When the guard BLOCKS, nothing is cancelled — the agent keeps talking — and the caller's swallowed turn (which the server no longer auto-answers while a response is active) is answered once protected playback finishes.
