export interface TranscriptEntry {
  role: 'user' | 'agent';
  text: string;
  /** Milliseconds since call start. */
  timestampMs: number;
  /** Which agent spoke / was active (multi-agent calls). */
  agentId?: string;
  /** The caller cut this utterance off mid-playback. */
  interrupted?: boolean;
}

/** One completed transfer, as recorded in the session's handoff history. */
export interface HandoffRecord {
  from: string;
  to: string;
  /** Milliseconds since call start. */
  atMs: number;
  reason?: string;
}

export interface TranscriptInjectionOptions {
  /** How many trailing transcript entries to replay. */
  maxTurns?: number;
  /** Agent id → display name, so replayed lines name the agent that spoke. */
  agentNames?: ReadonlyMap<string, string>;
  /** Completed transfers, interleaved so the replay carries routing too. */
  handoffs?: readonly HandoffRecord[];
}

/**
 * Render a transcript for history re-injection after reconnect/handoff.
 *
 * Agent lines are attributed to the agent that said them and completed
 * transfers are interleaved as `[transfer]` lines: an incoming agent handed a
 * flat `Agent:` dialogue re-derives intent from scratch, decides the request
 * belongs to somebody else, and transfers on — agents ping-ponging with no
 * caller turn between them (field bug, Aug 2026). Replaying WHO said what and
 * WHAT was already routed is what stops the second lap.
 */
export function formatTranscriptForInjection(
  entries: readonly TranscriptEntry[],
  options: TranscriptInjectionOptions = {},
): string {
  const { maxTurns = 30, agentNames, handoffs = [] } = options;
  const recent = entries.slice(-maxTurns);
  if (recent.length === 0) return '';

  const nameOf = (agentId: string | undefined): string =>
    (agentId ? agentNames?.get(agentId) : undefined) ?? agentId ?? 'Agent';

  const windowStartMs = recent[0]!.timestampMs;
  const lines: Array<{ atMs: number; text: string }> = recent.map((entry) => ({
    atMs: entry.timestampMs,
    text:
      entry.role === 'user'
        ? `Caller: ${entry.text}`
        : `${nameOf(entry.agentId)}: ${entry.text}`,
  }));
  for (const handoff of handoffs) {
    // Transfers older than the replayed window are already implied by the
    // attribution on the lines themselves.
    if (handoff.atMs < windowStartMs) continue;
    lines.push({
      atMs: handoff.atMs,
      text:
        `[transfer] ${nameOf(handoff.from)} -> ${nameOf(handoff.to)}` +
        (handoff.reason ? ` (reason: ${handoff.reason})` : ''),
    });
  }

  // Stable sort: on a tie the line that triggered the transfer stays ahead of it.
  return lines
    .sort((a, b) => a.atMs - b.atMs)
    .map((line) => line.text)
    .join('\n');
}
