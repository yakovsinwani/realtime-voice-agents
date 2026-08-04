# Fastify example — full-featured voice agent

Inbound + outbound calls, multi-agent handoff (receptionist → billing), tools in three execution strategies (`sync` with hold audio, `dispatch`, `humanInTheLoop`), interruption guard, idle nudges, and graceful hangup.

## Run it

```bash
npm install
cp .env.example .env   # fill in OPENAI_API_KEY (and Twilio creds for extras)
npm run dev
```

Expose it and wire Twilio:

```bash
ngrok http 3000
```

1. Put the `wss://…ngrok…` host into `.env` as `PUBLIC_WS_URL` (restart the server).
2. In the Twilio console, set your phone number's Voice webhook to `POST https://<ngrok-host>/twilio/voice`.
3. Call the number.

## Try during the call

- **Barge in** mid-sentence — the agent stops immediately (its context is truncated to what you actually heard). The first sentence of each reply is protected.
- **"Where is my order A-12345?"** — a slow `sync` tool; you'll hear soft typing while it runs.
- **"I want a refund"** — routes to the billing agent (handoff), whose refund tool pauses for human approval (auto-approved after 3s in this demo; watch the console).
- **"Text me a summary"** — a `dispatch` tool: the agent keeps talking while it runs.
- **Go quiet** — after ~12s the agent checks in on you; twice, and it says goodbye.
- **Say goodbye** — the graceful hangup lets the agent finish its farewell before the leg closes.

## Outbound

```bash
npm run call -- +15551234567
```

The greeting waits for the human to actually pick up (the status callback feeds `bridge.notifyAnswered`).
