# twilio-realtime-agents

Provider-agnostic bridge between **Twilio Media Streams** and **realtime speech-to-speech AI APIs** — OpenAI Realtime, xAI Grok Voice, and Gemini Live — for building phone voice agents in Node.js.

> Work in progress. Full documentation lands with `1.0.0`.

## Features (v1 scope)

- **Provider-agnostic** — one `Agent` / `tool()` / session API across OpenAI, xAI, and Gemini Live
- **Multi-agent handoffs** — swarm-style agent graph with auto-generated transfer tools
- **Tools with Zod schemas** and four execution strategies: `sync`, `dispatch`, `deferred`, `humanInTheLoop`
- **Mark-based playback tracking** — know when the caller actually *heard* the agent, not just when audio was generated
- **True barge-in** — Twilio buffer flush + `conversation.item.truncate` so the model's context matches what was heard
- **Interruption guards** — protect the first sentence, rate-limit noisy-environment interruptions
- **Background/hold audio** — bundled μ-law presets injected during slow tools and handoffs
- **Built-in call controls** — graceful `finishCall`, `transferCall`, SMS/WhatsApp
- **Pre-synthesized greeting** — burst-write the greeting while the provider connects (~1.5s to first word)
- **Testing harness** — fake Twilio media stream + fake provider servers, no phone calls needed

## License

MIT
