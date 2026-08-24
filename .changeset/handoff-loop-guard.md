---
'realtime-voice-agents': minor
---

Make multi-agent transfer loops structurally impossible, and replay history with attribution.

Two changes to how an agent receives control:

- **An agent that just took over cannot transfer again until the caller speaks.** The `transfer_to_<id>` call is refused with a tool result explaining why (so the model does not simply retry it), the active agent does not change, and the new `agent.handoff.blocked` session event fires instead of `agent.handoff`. A caller turn — speech, a user transcript, or a keypad entry — unlocks transfers again. `session.handoffTo()` is host intent and bypasses the lock, but still arms it for the agent it installs. Trade-off: a pure router node now costs an extra caller turn, so direct arcs between agents beat hub-and-spoke.
- **Replayed history is attributed.** The transcript re-injected after a handoff-reconnect or a provider reconnect now names the agent that said each line and interleaves completed transfers as `[transfer] A -> B (reason: …)` lines. A flat `Agent:` replay made every incoming agent re-derive intent from the same text, decide the request belonged to somebody else, and pass it on.

`CallSnapshot.handoffHistory` entries gained an optional `reason`.
