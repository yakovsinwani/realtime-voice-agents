import type { Logger } from '../logging/logger.js';
import type { Agent } from '../agents/Agent.js';
import type { BackgroundAudioSpec } from '../audio/background/presets.js';

/**
 * Session-scoped key/value context: seeded at call start (tenant id, caller
 * profile, …), readable and writable from any tool during the call, carried
 * across agent handoffs, and included in store snapshots.
 */
export class SessionContext {
  private readonly data = new Map<string, unknown>();

  constructor(initial?: Record<string, unknown>) {
    for (const [key, value] of Object.entries(initial ?? {})) this.data.set(key, value);
  }

  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  delete(key: string): boolean {
    return this.data.delete(key);
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.data);
  }
}

export interface ToolCallInfo {
  from?: string;
  to?: string;
  direction: 'inbound' | 'outbound';
  customParameters: Record<string, string>;
}

/**
 * Capability closures handed to tools — everything a tool may do to the live
 * call without ever touching the engine, the provider socket, or the Twilio
 * SDK (the sinwan ToolControl pattern).
 */
export interface CallSessionFacade {
  readonly callSid: string;
  /** Inject a text turn (e.g. steer the model or log a system note). */
  sendText(text: string, options?: { role?: 'user' | 'system'; triggerResponse?: boolean }): void;
  /** Gracefully end the call (goodbye-aware two-phase hangup). */
  finishCall(options?: { finalMessage?: string }): Promise<void>;
  /** Transfer the PSTN leg to another number (announced, playout-aware). */
  transferTo(phoneNumber: string, options?: { callerId?: string; announcement?: string }): Promise<void>;
  /** Swap the active agent (multi-agent handoff). */
  handoffTo(agent: Agent | string): Promise<void>;
  /** Start/stop background audio manually. */
  playBackgroundAudio(spec: BackgroundAudioSpec, options?: { volume?: number }): Promise<void>;
  stopBackgroundAudio(options?: { fadeOutMs?: number }): Promise<void>;
  /** Complete a `deferred` tool from outside its execute() promise. */
  submitToolResult(toolCallId: string, result: unknown): void;
}

export interface ToolContext {
  callSid: string;
  /** The agent this tool call belongs to. */
  agent: Agent;
  session: CallSessionFacade;
  context: SessionContext;
  callInfo: ToolCallInfo;
  logger: Logger;
  /** Aborted on tool timeout or call teardown — pass to fetch etc. */
  signal: AbortSignal;
  /** Provider tool-call id (correlates deferred results). */
  toolCallId: string;
}
