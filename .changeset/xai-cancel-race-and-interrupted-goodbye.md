---
"twilio-realtime-agents": patch
---

Two field fixes from live xAI (Grok Voice) calls:

- Barge-ins no longer send `response.cancel` on providers without `vadInterruptControl` (xAI/Gemini) — their servers already cancelled on speech onset, so the bridge's cancel always raced and surfaced as a spurious session `error`. xAI's benign cancel-race shape (generic `invalid_request_error` code with a "Cancellation failed: no active response" message) is now also classified as benign, matching OpenAI's `response_cancel_not_active` handling.
- A caller talking over the goodbye now completes the hangup immediately: the flushed farewell's playout can never confirm, so waiting on the 7s watchdog just produced dead air at the end of the call.
