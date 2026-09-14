---
'realtime-voice-agents': patch
---

GPT-Live: a playout lead removes jitter-induced choppiness.

The Live model streams at exactly real-time pace, so Twilio's outbound buffer never runs ahead of playout and every delivery hiccup between OpenAI, your server and Twilio was an audible gap (unlike Realtime, whose faster-than-real-time generation keeps seconds of cushion at Twilio). The provider now holds the first 200 ms of each utterance — the last idle delta included, so soft onsets are no longer clipped at the speech gate — then flushes and streams through, keeping Twilio that far ahead. `gptLive({ playoutLeadMs })` tunes it; `0` restores the previous forward-as-it-arrives behavior. Cost: ~200 ms on the first word of each agent turn.
