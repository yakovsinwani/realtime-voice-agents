---
'twilio-realtime-agents': minor
---

Simpler configuration:

- **Removed** `interruptions.preventInterruptionOnFirstSentence`. It lifted when the first sentence finished *generating* (transcript text), which happens well before the caller hears it — use `deafness.ignoreUserAudioUntilFirstTurnDone` (playback-truth based) or `guardDurationMs` instead.
- Provider factories now auto-detect API keys from common env var aliases when no explicit `apiKey` is passed (explicit keys always win): OpenAI `OPENAI_API_KEY`/`OPENAI_KEY`/`OPEN_AI_API_KEY`, xAI `XAI_API_KEY`/`GROK_API_KEY`/`XAI_KEY`, Gemini `GOOGLE_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_GENAI_API_KEY`. The lists are exported as `*_KEY_ENV_VARS` constants.
