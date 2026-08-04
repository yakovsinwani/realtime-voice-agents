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

/** Render a transcript for history re-injection after reconnect/handoff. */
export function formatTranscriptForInjection(entries: readonly TranscriptEntry[], maxTurns = 30): string {
  const recent = entries.slice(-maxTurns);
  return recent
    .map((entry) => `${entry.role === 'user' ? 'Caller' : 'Agent'}: ${entry.text}`)
    .join('\n');
}
