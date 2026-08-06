---
'twilio-realtime-agents': minor
---

**Behavior change**: `deafness.ignoreUserAudioUntilFirstTurnDone` now defaults to `true` — caller audio is dropped until the agent's first turn finishes playing, protecting the greeting from noisy pickups. With `greeting.mode: 'user-initiates'` the default stays `false` (the caller must be heard to start the call); an explicit setting is honored either way. A played pre-synthesized greeting and a silent first response (no audio, no tool work) now count as the first turn, so the deafness window always closes. Set `deafness: { ignoreUserAudioUntilFirstTurnDone: false }` to restore the previous behavior.
