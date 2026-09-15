---
"realtime-voice-agents": patch
---

docs: README gains a "Using GPT-Live (full-duplex)" guide right after the quick start — the two-prompt pattern (voice prompt on the Agent, backend prompt on `gptLive({ delegation })`), the "delegate first, announce after" rule, tools without hold audio, greeting as commentary, and a multi-agent switchboard with a voice per agent, per-agent backend prompts via `providerOptions`, and `handoffHold` covering the reopen. Mirrors the production setup so the npm page shows how to run GPT-Live, not only what differs.
