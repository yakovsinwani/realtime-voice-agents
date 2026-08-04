/**
 * Capability flags per provider. The engine branches on these — never on a
 * provider's name — so new providers slot in without touching session logic.
 */
export interface ProviderCapabilities {
  /** Supports trimming the last assistant item to what was actually heard. */
  truncate: boolean;
  /** Supports mid-session instruction/tool swaps (session.update). */
  sessionUpdate: boolean;
  /** Voice can change after audio has been emitted in the session. */
  voiceChangeMidSession: boolean;
  /** Provider speaks PCM — the μ-law wire format must be transcoded. */
  transcodeRequired: boolean;
  /** Supports server-side session resumption handles. */
  resumption: boolean;
  /** Streams assistant transcript deltas (enables first-sentence detection). */
  agentTranscriptDeltas: boolean;
}
