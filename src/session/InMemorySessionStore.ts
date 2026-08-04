import type { CallSnapshot } from './snapshot.js';
import type { SessionStore } from './SessionStore.js';

export class InMemorySessionStore implements SessionStore {
  private readonly snapshots = new Map<string, CallSnapshot>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
  }

  async save(snapshot: CallSnapshot): Promise<void> {
    this.snapshots.set(snapshot.callSid, structuredClone(snapshot));
    // Bounded: evict the oldest entries so long-running processes don't grow.
    while (this.snapshots.size > this.maxEntries) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
  }

  async load(callSid: string): Promise<CallSnapshot | null> {
    const snapshot = this.snapshots.get(callSid);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async delete(callSid: string): Promise<void> {
    this.snapshots.delete(callSid);
  }

  /** All stored snapshots (testing/debugging). */
  list(): CallSnapshot[] {
    return [...this.snapshots.values()].map((s) => structuredClone(s));
  }
}
