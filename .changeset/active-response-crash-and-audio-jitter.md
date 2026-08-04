---
"twilio-realtime-agents": patch
---

Fix a host-process crash on `conversation_already_has_active_response` and reduce audio stutter on the OpenAI/xAI path.

- **`response.create` is now serialized per session.** Creates requested while a response is in flight wait in a coalescing pending slot and fire on `response.done` (explicit instructions survive later bare triggers). Flushing the tool-result queue now sends one `response.create` for all drained results instead of one per result — the pattern that made the GA API reject the call mid-conversation.
- **Benign protocol races no longer crash the host.** `conversation_already_has_active_response` (our create lost a race to a VAD-created response) is logged, and the rejected create is re-armed to fire when the active response completes; `response_cancel_not_active` is logged and ignored. Genuinely fatal provider errors still emit `error` — but an unhandled `'error'` event on any package emitter no longer throws (Node otherwise kills the process); `CallSession` logs the error when no listener is attached.
- **`permessage-deflate` is disabled on the provider WebSocket.** Every audio delta was being inflated through ws's async zlib queue, adding per-chunk latency jitter to playback for no meaningful bandwidth gain on base64 μ-law.
