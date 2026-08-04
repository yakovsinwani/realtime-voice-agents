/**
 * twilio-realtime-agents — provider-agnostic bridge between Twilio Media
 * Streams and realtime speech-to-speech AI APIs.
 *
 * Core entry point: bridge, session, Agent, tool(), events, and shared types.
 * Provider factories live in the subpath exports: `twilio-realtime-agents/openai`,
 * `/xai`, `/gemini`. Twilio helpers in `/twilio`, audio primitives in `/audio`,
 * session stores in `/store`, and test fakes in `/testing`.
 */

export const VERSION = '0.0.0';
