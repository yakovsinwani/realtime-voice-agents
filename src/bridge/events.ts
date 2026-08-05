import type { Agent } from '../agents/Agent.js';
import type { ProviderUsage } from '../providers/base/events.js';
import type { TranscriptEntry } from '../session/transcript.js';
import type { UsageInfo } from '../session/usage.js';
import type { CallSession } from './CallSession.js';
import type { CallEndReason } from './state.js';

export interface CallStartedInfo {
  callSid: string;
  streamSid: string;
  direction: 'inbound' | 'outbound';
  from?: string;
  to?: string;
  customParameters: Record<string, string>;
}

export interface ToolRunInfo {
  toolCallId: string;
  toolName: string;
  strategy: string;
  agentId: string;
  input?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ApprovalRequestInfo {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  agentId: string;
  expiresAtMs: number;
}

// No `extends Record<string, ...>` here: an index signature would widen
// `keyof` to `string` and let misspelled event names compile silently.
export interface SessionEventMap {
  'call.started': (info: CallStartedInfo) => void;
  'call.ended': (info: { reason: CallEndReason; durationMs: number; usage: UsageInfo }) => void;
  'call.failed': (error: Error) => void;

  'provider.connected': () => void;
  'provider.reconnecting': (info: { attempt: number; delayMs: number }) => void;
  'provider.reconnected': () => void;
  'provider.closed': (info: { code?: number; reason?: string }) => void;

  /** Generation-side: the model started/finished producing a response. */
  'agent.speech.started': (info: { responseId: string }) => void;
  'agent.speech.ended': (info: { responseId: string }) => void;

  /** Playback-side (mark-confirmed): what the caller actually hears. */
  'playback.started': (info: { responseId: string }) => void;
  'playback.finished': (info: { responseId: string; playedMs: number }) => void;
  'playback.interrupted': (info: { responseId: string; playedMs: number }) => void;

  'user.speech.started': () => void;
  'user.speech.ended': () => void;

  'transcript.user': (entry: TranscriptEntry) => void;
  'transcript.agent': (entry: TranscriptEntry) => void;

  'tool.started': (info: ToolRunInfo) => void;
  'tool.completed': (info: ToolRunInfo) => void;
  'tool.failed': (info: ToolRunInfo) => void;
  'tool.approval.required': (request: ApprovalRequestInfo) => void;

  'agent.handoff': (info: { from: Agent; to: Agent; reason?: string }) => void;

  interruption: (info: { responseId: string; playedMs: number }) => void;
  'interruption.blocked': (info: { cause: string }) => void;

  'background_audio.started': (info: { preset?: string }) => void;
  'background_audio.stopped': (info: { preset?: string }) => void;

  dtmf: (info: { digit: string }) => void;
  'usage.updated': (usage: UsageInfo, delta: ProviderUsage) => void;
  error: (error: Error) => void;
}

export interface BridgeEventMap {
  'session.started': (session: CallSession) => void;
  'session.ended': (info: { callSid: string; reason: CallEndReason }) => void;
  'connection.rejected': (info: { reason: string }) => void;
  error: (error: Error) => void;
}
