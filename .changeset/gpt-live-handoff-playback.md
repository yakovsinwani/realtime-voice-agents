---
'realtime-voice-agents': patch
---

GPT-Live: handoffs no longer cut the voice mid-sentence, hold audio actually covers the reopen, and a cut utterance can no longer wedge playback.

- On providers with `turnTaking: 'model'` a backend transfer lands while the voice is still speaking the sentence that announces it, and the handoff is a close-and-reopen. The bridge now holds the handoff until that utterance has played out plus one sentence gap (a new utterance cancels it; capped at 5 s so a voice that never stops still hands off). Before: "one moment, transferring y—" and dead air (field, Sept 2026).
- `session.handoffHold` now plays on GPT-Live: the in-flight deltas of the sentence being cut used to kill the hold during its start delay, so it never started.
- Closing a provider session for a handoff or reconnect abandons its open playback tracks (`PlaybackTracker.abandonOpen`). An utterance cut by the close never got its final mark, which left `isPlaybackActive()` true for the rest of the call — the hangup grace never armed and calls ended only by the 7 s watchdog (11 s of dead air after the goodbye); a REST transfer would have waited forever.
- `deafness.ignoreUserAudioUntilFirstTurnDone` is now unset by default and resolves per provider: true where the bridge owns barge-in, false with `greeting.mode: 'user-initiates'` and on full-duplex providers (the model owns talk-over; "deaf" there only fed it silence). An explicit value is honored as written.
