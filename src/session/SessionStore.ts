import type { CallSnapshot } from './snapshot.js';

/**
 * Durable checkpoint store (LangGraph-checkpointer-inspired). Snapshots are
 * written at call start, agent handoff, tool completion, and call end — never
 * read on the audio hot path. Implement over Redis/Postgres for multi-instance
 * observability and post-call processing; the in-memory default suffices for
 * single-process deployments.
 */
export interface SessionStore {
  save(snapshot: CallSnapshot): Promise<void>;
  load(callSid: string): Promise<CallSnapshot | null>;
  delete(callSid: string): Promise<void>;
}
