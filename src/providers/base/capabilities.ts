/**
 * The provider's server-VAD tuning envelope. Declared by provider factories
 * (never by the generic OpenAI-compatible base — an arbitrary compatible
 * service must not silently inherit OpenAI's defaults). Noise-adaptive VAD
 * refuses to invent a threshold baseline: absent both this profile and an
 * explicit configured threshold, the numeric ladder stays unavailable.
 */
export interface VadTuningProfile {
  /** The provider's effective server-VAD threshold when none is configured. */
  defaultServerThreshold?: number;
  /** Lowest threshold the provider accepts (clamp target). */
  minServerThreshold?: number;
  /** Highest threshold the provider accepts (clamp target). */
  maxServerThreshold?: number;
}

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
  /**
   * Server-VAD threshold envelope for noise-adaptive tuning. Optional; absent
   * means the provider declared none (see VadTuningProfile).
   */
  vadTuning?: VadTuningProfile;
  /**
   * Who decides when the agent speaks and stops. `'bridge'` (absent): the
   * provider's server VAD detects turns and the bridge arbitrates barge-ins
   * (cancel / clear / truncate through the interruption guard). `'model'`: a
   * full-duplex model listens while it talks and handles interruptions itself
   * (GPT-Live). The bridge then never cancels, clears or truncates, the
   * interruption guard is observe-only, `user.speech.*` events are not
   * available, and deafness options substitute silence for caller audio
   * instead of dropping frames (the model's session clock runs on input).
   * Documented fallback, pinned in the parity tests.
   */
  turnTaking?: 'bridge' | 'model';
  /**
   * `connect()` seeds `init.history` into the new server session, so the
   * engine skips post-connect transcript re-injection on reconnects and
   * handoff-reconnects (GPT-Live `session.input`).
   */
  startupHistory?: boolean;
  /**
   * Tool results feed a backend that runs independently of speech (the voice
   * model keeps talking while it works), so holding them until playback
   * finishes only adds latency: the engine delivers results and deferred
   * injections immediately, regardless of `toolResultDelivery`. Usage is
   * accounted from the provider's `usage` events (no response carries it).
   */
  decoupledBackend?: boolean;
}
