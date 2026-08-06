---
'twilio-realtime-agents': minor
---

Add `deafness.muteWhileAgentSpeaking`: drop caller audio while agent audio is audibly playing (half-duplex mode for extreme-noise environments). Caller speech during agent playback is lost, not queued — prefer `interruptions.enabled: false` when blocked speech should still be answered afterwards. Default false.
