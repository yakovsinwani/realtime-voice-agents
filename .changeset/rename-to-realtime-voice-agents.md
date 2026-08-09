---
'realtime-voice-agents': major
---

Renamed the package from `twilio-realtime-agents` to `realtime-voice-agents`.

No API changes — every export, subpath, option, and event is identical. The
only migration is the specifier:

```diff
-import { Agent, TwilioRealtimeBridge } from 'twilio-realtime-agents';
-import { openaiRealtime } from 'twilio-realtime-agents/openai';
+import { Agent, TwilioRealtimeBridge } from 'realtime-voice-agents';
+import { openaiRealtime } from 'realtime-voice-agents/openai';
```

```bash
npm uninstall twilio-realtime-agents && npm install realtime-voice-agents
```

`twilio-realtime-agents` is deprecated on npm at 1.2.0 and receives no further
releases. The `twilio-` prefix implied an official Twilio package, which this
has never been — it is an independent MIT project, not affiliated with Twilio,
OpenAI, xAI, or Google.
