---
"twilio-realtime-agents": patch
---

Interleave Twilio playback marks at checkpoints instead of after every audio delta. Field testing (A/B with marks disabled) showed that doubling the message count on the Twilio media socket audibly degrades playback smoothness. Marks now go out after the first chunk of a response (exact `playback.started`), every ~1s of audio, and after the final chunk when generation completes (exact `playback.finished`) — cutting mark traffic ~90% on long responses. `PlaybackTracker.onAudioSent` now returns `string | null`, and `onGenerationDone` returns the final tail mark to send (`string | null`); truncate estimates between echoes rely on the existing wall-clock interpolation, so barge-in accuracy is bounded by echo jitter, not the checkpoint interval.
