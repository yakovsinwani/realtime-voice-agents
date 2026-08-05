---
"twilio-realtime-agents": patch
---

Gemini Live setup failures no longer crash the host process. When the server refuses a session during setup (e.g. close 1007 for an unsupported config), both the SDK's connect promise and the provider's internal setup promise reject; the rejection `connect()` did not rethrow escaped as a process-killing unhandledRejection. Both rejections are now always observed, and `connect()` surfaces the server's close code and reason instead of the SDK's generic connect failure.
