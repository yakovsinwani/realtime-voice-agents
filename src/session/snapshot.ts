import type { TranscriptEntry } from './transcript.js';
import type { UsageInfo } from './usage.js';

/** Serializable checkpoint of a call, written to the SessionStore. */
export interface CallSnapshot {
  callSid: string;
  streamSid: string | null;
  state: string;
  activeAgentId: string;
  transcript: TranscriptEntry[];
  usage: UsageInfo;
  context: Record<string, unknown>;
  handoffHistory: Array<{ from: string; to: string; atMs: number }>;
  /** Gemini session-resumption handle, when the provider supplies one. */
  resumptionHandle?: string;
  startedAtMs: number;
  endedAtMs?: number;
  endReason?: string;
}
