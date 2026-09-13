/** Normalized events every provider emits, regardless of wire protocol. */

export interface RawUsage {
  [key: string]: unknown;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokenDetails?: { textTokens?: number; audioTokens?: number; cachedTokens?: number };
  outputTokenDetails?: { textTokens?: number; audioTokens?: number };
  /**
   * Cumulative session audio seconds for duration-billed providers (GPT-Live).
   * A running total, not an increment: accumulators keep the latest value.
   */
  audioSeconds?: number;
  /** Provider-native payload for advanced analytics. */
  raw?: RawUsage;
}

export interface ProviderAudioDelta {
  /** Base64 μ-law 8 kHz — already in Twilio wire format. */
  base64Mulaw: string;
  responseId: string;
  itemId?: string;
}

export interface ProviderToolCall {
  /** Provider call id used to correlate the result (function name on providers without ids). */
  id: string;
  name: string;
  argumentsJson: string;
  responseId?: string;
  itemId?: string;
}

export interface ProviderCloseInfo {
  code?: number;
  reason?: string;
  /** False for auth/config failures where retrying is pointless. */
  retriable: boolean;
}

// No `extends Record<string, ...>` — see SessionEventMap for why.
export interface ProviderEvents {
  open: () => void;
  close: (info: ProviderCloseInfo) => void;
  error: (error: Error) => void;
  /** Assistant audio chunk, normalized to base64 μ-law. */
  audio: (delta: ProviderAudioDelta) => void;
  /** A new assistant response began generating. */
  responseStarted: (info: { responseId: string }) => void;
  /** The assistant response finished generating (audio may still be playing out). */
  responseDone: (info: { responseId: string; usage?: ProviderUsage }) => void;
  /** An output item was added — carries the itemId needed for truncation. */
  outputItemAdded: (info: { itemId: string; responseId: string }) => void;
  toolCall: (call: ProviderToolCall) => void;
  userSpeechStarted: () => void;
  userSpeechStopped: () => void;
  userTranscript: (entry: { text: string }) => void;
  agentTranscriptDelta: (entry: { responseId: string; delta: string }) => void;
  agentTranscript: (entry: { responseId: string; text: string }) => void;
  usage: (usage: ProviderUsage) => void;
  /** Session-resumption handle refresh (Gemini). */
  resumptionUpdate: (handle: string) => void;
  /** Provider announced imminent disconnect (Gemini GoAway). */
  goAway: (info: { timeLeftMs?: number }) => void;
}
