---
'realtime-voice-agents': patch
---

GPT-Live: a speech-gate close and reopen inside one delta no longer leaves an utterance open for the rest of the call.

When the quiet window ended and speech resumed within the same 100 ms delta, the provider started the new utterance first and then ended it — the old one never got its `responseDone`, its playback track never finished, and everything gated on `isPlaybackActive()` (deferred handoffs, the hangup grace, REST transfers) fell back to its watchdog or cap (field, Sept 2026). Gate events now apply in order, the delta is attributed to the utterance that is open when it ends, and `beginUtterance` never leaves a previous utterance open. The deferred-handoff cap is raised from 5 s to 8 s: one announce plus a stray utterance plus the sentence grace lands right at 5 s.
