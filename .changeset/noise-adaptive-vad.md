---
'realtime-voice-agents': minor
---

Add opt-in noise-adaptive VAD (`session.noiseAdaptiveVad`): a per-frame μ-law noise-floor meter on inbound caller audio escalates turn detection mid-call when the line is persistently noisy. Server-VAD `threshold` steps up via ack-gated `session.update` (default one step per call, escalate-only, cooldown between steps); semantic VAD and Gemini receive `vad.suggestion` events instead of automatic changes. Baselines come from each provider's declared `capabilities.vadTuning` profile (OpenAI 0.5, xAI 0.85) or the configured threshold — never guessed. Caller speech, agent playback, and the pre-synthesized greeting are excluded from the floor estimate, so a long monologue in a quiet room never escalates.

New public API: `session.updateVad(vad)` (persists across reconnects/handoffs, rebases the adaptive ladder; `null` disables turn detection and adaptation), session events `vad.suggestion`/`vad.adjusted`, `NoiseAdaptiveVadController`, and `NoiseFloorEstimator`/`mulawFrameDbfs` in `realtime-voice-agents/audio`.

Ships with supporting changes:

- Bug fix (applies regardless of the feature): `updateSession({ vad })` now re-applies the bridge-owned `interrupt_response: false` injection — previously a mid-call vad patch silently re-enabled server-side auto-interrupt, breaking guarded barge-ins.
- Opt-in serialized session updates: with `noiseAdaptiveVad` configured, every mid-call `session.update` for that session is sent one at a time with snapshot payloads and waits for its `session.updated` ack (timeout ⇒ reconnect into known-good state). Without the feature, updates keep the fire-and-forget behavior exactly as before.
- Provider interface additions for custom `BaseRealtimeProvider` implementations: `updateSession(patch, { awaitAck? })` now returns `Promise<boolean | void>` (`true` = acknowledged), `getEffectiveVad()`, `ProviderSessionInit.serializedSessionUpdates`, and optional `capabilities.vadTuning`.
