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
  /**
   * Server VAD's auto-interrupt can be disabled (`interrupt_response: false`),
   * letting the bridge own barge-in: cancel/clear/truncate only when the
   * interruption guard allows. Without it, the provider cancels generation on
   * speech onset regardless of the guard — the guard then protects only the
   * already-buffered Twilio audio (documented fallback, see parity tests).
   * Optional so existing third-party providers keep compiling (absent = false).
   */
  vadInterruptControl?: boolean;
}
