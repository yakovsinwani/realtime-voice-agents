---
"twilio-realtime-agents": patch
---

Three hardening fixes from field testing:

- HTTP-rejected WebSocket upgrades (401 bad key, 403 no credits, 404 bad path) now fail the connect with the provider's actual status and response body instead of a bare close code 1006 — xAI's "team has no credits" verdict was previously invisible.
- Event maps no longer carry a string index signature, so a misspelled event name (`session.on("tool.succeeded", ...)` — the real event is `tool.completed`) is now a compile-time error instead of a listener that silently never fires. If your build breaks on an event name after upgrading, the listener was never firing to begin with.
- The interruption guard is no longer disarmed by a response that starts while the guarded response's audio is still playing (the server auto-answers a guard-blocked caller turn as soon as generation — not playback — finishes; with `firstResponseOnly` that phantom response burned the guard mid-greeting). Guard rotation now defers until the guarded playback actually ends.
