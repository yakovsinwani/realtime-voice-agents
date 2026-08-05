# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commands

```bash
npm test                 # vitest run (all suites, ~1.5s — includes real-WS integration)
npx vitest run <file>    # single suite
npm run typecheck        # tsc --noEmit (strict, NodeNext)
npm run lint             # eslint flat config
npm run build            # tsdown → dist/ (dual ESM .mjs + CJS .cjs, d.mts/d.cts)
npm run check            # typecheck + lint + build + publint + attw (release gate)
npm run assets:generate  # re-synthesize assets/*.ulaw hold-audio loops
```

## What this is

`twilio-realtime-agents` — a public npm package bridging **Twilio Media Streams** (WebSocket, μ-law 8 kHz) to **realtime speech-to-speech APIs**: OpenAI Realtime (GA protocol ONLY — never add beta wire shapes like `g711_ulaw`/`response.audio.delta`), xAI Grok Voice (OpenAI-compatible, own session shape), and Gemini Live (via `@google/genai`, optional peer).

## Architecture invariants

- **The engine is μ-law-only.** `CallSession` never sees PCM. Providers that speak PCM (Gemini) own their transcoding internally (`src/audio/transcode.ts` — stateful; never process chunks independently, the resampler carries inter-chunk FIR history).
- **Capability flags, not provider names.** `CallSession` branches on `provider.capabilities.{truncate,sessionUpdate,resumption,...}` — never on `provider.name`. New providers implement `BaseRealtimeProvider` (`src/providers/base/`) and emit its normalized events.
- **Playback truth comes from marks — at checkpoints, not per delta.** A `tra:N` mark is interleaved after the FIRST audio chunk of a response (exact `playback.started`), then every ~1s of audio, then after the final chunk on generation done (exact `playback.finished`); Twilio echoes marks at playout and `PlaybackTracker` classifies echoes (played vs flushed via clear-epochs), interpolating wall-clock between echoes for truncate estimates. Never go back to a mark per delta (doubling the Twilio message count audibly degraded playback in field testing — Aug 2026), and never reintroduce wall-clock "the audio probably finished" timers — that bug class is why this design exists.
- **One mutable CallSession owns per-call state.** The `SessionStore` receives immutable snapshots at checkpoints; it is never read on the audio path.
- **Tool results queue FIFO** (`afterPlayback` default) and flush on `playback.finished`. Never a single slot.
- **Teardown is centralized** in `CallSession.teardown()`: every timer/AbortController/socket/audio-loop must be released there, idempotently.
- **LLM output never reaches markup or shell.** Phone numbers are validated + XML-escaped before TwiML interpolation (`src/twilio/rest.ts`).

## Layout

`src/bridge/` engine (CallSession = orchestrator, ~1100 lines) · `src/providers/` base + openai-compatible + gemini · `src/tools/` tool()/strategies/middleware · `src/playback/` mark tracker · `src/interruption/` guards + rate limiter · `src/audio/` mulaw/resampler/transcode + background player · `src/testing/` fakes (shipped via `/testing` subpath) · entry files `src/{index,openai,xai,gemini,store}.ts` + `src/{twilio,audio,testing}.entry.ts` map 1:1 to subpath exports in package.json.

## Testing conventions

Integration tests run the REAL bridge between `FakeTwilioMediaStream` (deterministic playout: marks echo only after preceding media "plays"; `clear` echoes pending marks — matches Twilio exactly) and `FakeOpenAIServer` (real WebSocket) / `FakeGeminiLive` (SDK seam). When testing playback-dependent behavior, **wait for media to arrive at the fake before calling `playAll()`** — provider frames travel over a real socket. Provider parity lives in `src/bridge/parity.test.ts`: any knob a provider can't honor must have its documented fallback asserted there. `genai-drift.test.ts` pins the `@google/genai` surface we depend on.

## Releasing

Changesets: add a `.changeset/*.md`, CI (release.yml) opens the version PR and publishes with provenance on merge. `attw` runs with `--profile node16` (node10 subpath resolution is intentionally unsupported; engines is >=20).
