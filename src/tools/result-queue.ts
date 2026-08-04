/**
 * FIFO queue of tool results awaiting delivery.
 *
 * Results produced while the agent is generating or audible are held until
 * `playback.finished`, then flushed in completion order. A queue — not a
 * single slot — so concurrent tool completions are never silently dropped.
 */

export interface PendingToolResult {
  callId: string;
  toolName: string;
  payload: unknown;
  triggerResponse: boolean;
}

export class ToolResultQueue {
  private items: PendingToolResult[] = [];

  get size(): number {
    return this.items.length;
  }

  enqueue(item: PendingToolResult): void {
    this.items.push(item);
  }

  /** Remove and return everything, in arrival order. */
  drain(): PendingToolResult[] {
    const drained = this.items;
    this.items = [];
    return drained;
  }

  clear(): void {
    this.items = [];
  }
}
