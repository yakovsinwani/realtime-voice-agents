/**
 * Twilio Media Streams wire messages.
 * Reference: https://www.twilio.com/docs/voice/media-streams/websocket-messages
 *
 * Inbound (Twilio → server): connected, start, media, stop, mark, dtmf.
 * Outbound (server → Twilio): media, mark, clear.
 * All media payloads are base64 μ-law 8 kHz mono on `<Connect><Stream>` calls.
 */

export interface TwilioConnectedEvent {
  event: 'connected';
  protocol?: string;
  version?: string;
}

export interface TwilioStartEvent {
  event: 'start';
  sequenceNumber?: string;
  streamSid: string;
  start: {
    streamSid: string;
    accountSid?: string;
    callSid: string;
    tracks?: string[];
    mediaFormat?: { encoding: string; sampleRate: number; channels: number };
    /** `<Parameter name="…" value="…"/>` pairs from the TwiML `<Stream>`. */
    customParameters?: Record<string, string>;
  };
}

export interface TwilioMediaEvent {
  event: 'media';
  sequenceNumber?: string;
  streamSid: string;
  media: {
    track?: 'inbound' | 'outbound';
    chunk?: string;
    /** Milliseconds since stream start — the honest wall clock of the call. */
    timestamp?: string;
    /** Base64 μ-law audio. */
    payload: string;
  };
}

export interface TwilioStopEvent {
  event: 'stop';
  sequenceNumber?: string;
  streamSid: string;
  stop?: { accountSid?: string; callSid?: string };
}

export interface TwilioMarkEvent {
  event: 'mark';
  sequenceNumber?: string;
  streamSid: string;
  mark: { name: string };
}

export interface TwilioDtmfEvent {
  event: 'dtmf';
  streamSid: string;
  sequenceNumber?: string;
  dtmf: { track?: string; digit: string };
}

export type TwilioInboundMessage =
  | TwilioConnectedEvent
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioStopEvent
  | TwilioMarkEvent
  | TwilioDtmfEvent;

export interface TwilioOutboundMedia {
  event: 'media';
  streamSid: string;
  media: { payload: string };
}

export interface TwilioOutboundMark {
  event: 'mark';
  streamSid: string;
  mark: { name: string };
}

export interface TwilioOutboundClear {
  event: 'clear';
  streamSid: string;
}

export type TwilioOutboundMessage = TwilioOutboundMedia | TwilioOutboundMark | TwilioOutboundClear;

const INBOUND_EVENTS = new Set(['connected', 'start', 'media', 'stop', 'mark', 'dtmf']);

/**
 * Parse a raw WebSocket frame into a Twilio inbound message.
 * Returns null for non-JSON frames or unknown event types (Twilio may add
 * events; unknown ones must not crash a live call).
 */
export function parseTwilioMessage(raw: string | Buffer): TwilioInboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = (parsed as { event?: unknown }).event;
  if (typeof event !== 'string' || !INBOUND_EVENTS.has(event)) return null;
  return parsed as TwilioInboundMessage;
}
