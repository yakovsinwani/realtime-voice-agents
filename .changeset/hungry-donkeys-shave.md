---
"twilio-realtime-agents": patch
---

Never truncate a live goodbye: the hangup watchdog is now evidence-based. Previously `finish_call` armed a fixed one-shot timer (`hangup.markTimeoutMs`, 7s) that force-completed the hangup even while the farewell was still being generated or audibly playing — a slow goodbye generation plus a longish farewell was cut off mid-sentence, on every provider. The watchdog now re-arms whenever goodbye progress arrives (audio deltas forwarded, the goodbye response starting, mark echoes coming home) and forces completion only after a full `markTimeoutMs` window with no evidence at all. Dead sockets and models that never say goodbye still complete within one or two quiet windows.
