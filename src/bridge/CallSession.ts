/**
 * CallSession — the per-call orchestrator.
 *
 * One mutable object owns all live state for a call (no split-brain between a
 * store and hot data). The SessionStore only receives immutable snapshots at
 * checkpoints, never reads on the audio path. Teardown is centralized and
 * idempotent: every timer, tool AbortController, provider socket, and Twilio
 * socket is released exactly once.
 */

import { MULAW_SILENCE_BYTE, base64ByteLength, mulawBytesToMs } from '../audio/mulaw.js';
import { BackgroundAudioPlayer } from '../audio/background/BackgroundAudioPlayer.js';
import type { BackgroundAudioOptions, BackgroundAudioSpec } from '../audio/background/presets.js';
import type { Agent } from '../agents/Agent.js';
import { collectAgentGraph } from '../agents/Agent.js';
import { createHandoffTool, isHandoffDirective } from '../agents/handoff.js';
import {
  DEFAULT_KEYPAD_CLEAR_MESSAGE,
  DEFAULT_KEYPAD_INSTRUCTIONS,
  KeypadCollector,
  defaultKeypadMessage,
  type KeypadEntry,
  type KeypadHandle,
} from '../dtmf/KeypadCollector.js';
import { InterruptionController } from '../interruption/InterruptionController.js';
import { TypedEmitter } from '../internal/events.js';
import { childLogger, type Logger } from '../logging/logger.js';
import { PlaybackTracker } from '../playback/PlaybackTracker.js';
import type {
  BaseRealtimeProvider,
  ProviderFactory,
  ProviderHistoryEntry,
  ProviderSessionInit,
  VadConfig,
} from '../providers/base/BaseRealtimeProvider.js';
import {
  NoiseAdaptiveVadController,
  type VadAdjustment,
} from '../vad/NoiseAdaptiveVadController.js';
import { delayForAttempt } from '../providers/base/reconnect.js';
import type { ProviderToolCall } from '../providers/base/events.js';
import type { CallSnapshot } from '../session/snapshot.js';
import type { SessionStore } from '../session/SessionStore.js';
import { readFileSync } from 'node:fs';
import {
  buildHistoryForSeeding,
  formatTranscriptForInjection,
  type HandoffRecord,
  type TranscriptEntry,
} from '../session/transcript.js';
import { UsageAccumulator, type UsageInfo } from '../session/usage.js';
import { SessionContext, type CallSessionFacade, type ToolCallInfo, type ToolContext } from '../tools/context.js';
import { composeExecution, decorateTool, type ToolMiddleware } from '../tools/middleware.js';
import { ToolResultQueue } from '../tools/result-queue.js';
import type { Tool } from '../tools/tool.js';
import { createFinishCallTool } from '../tools/builtins/finishCall.js';
import { createTransferCallTool } from '../tools/builtins/transferCall.js';
import type { TwilioMediaTransport } from '../twilio/transport.js';
import type { TwilioStartEvent } from '../twilio/messages.js';
import type { TwilioRestClient } from '../twilio/rest.js';
import type { BuiltinToolsConfig, SessionOptions } from './config.js';
import type { SessionEventMap } from './events.js';
import type { CallEndReason, CallState } from './state.js';

const MAX_BUFFERED_INBOUND_FRAMES = 250; // ~5s of 20ms frames

/**
 * Cap on the noise meter's caller-speech exclusion: Gemini never emits a
 * speech-stopped event, and phantom speech starts on a noisy line must not
 * latch the meter off forever.
 */
const MAX_SPEECH_EXCLUSION_MS = 15_000;

export interface CallSessionDeps {
  transport: TwilioMediaTransport;
  start: TwilioStartEvent;
  providerFactory: ProviderFactory;
  /** Backup factories tried in order when `providerFactory` fails to connect. */
  fallbacks?: readonly ProviderFactory[];
  agent: Agent;
  options: SessionOptions;
  store: SessionStore;
  logger: Logger;
  builtinTools?: BuiltinToolsConfig;
  rest?: TwilioRestClient;
  restCallerId?: string;
  answeredEarly?: boolean;
  middlewares?: readonly ToolMiddleware[];
  onEnded?: (callSid: string, reason: CallEndReason) => void;
}

export class CallSession extends TypedEmitter<SessionEventMap> {
  readonly callSid: string;
  readonly streamSid: string;
  readonly callInfo: ToolCallInfo;
  readonly context: SessionContext;
  /**
   * Keypad (DTMF) input handle: digits buffered so far, `clear()`, `submit()`.
   * Inert (empty, no-ops) unless the `keypad` session option is configured.
   */
  readonly keypad: KeypadHandle;

  private stateValue: CallState = 'connecting';
  private readonly deps: CallSessionDeps;
  private readonly log: Logger;
  private readonly tracker = new PlaybackTracker();
  private readonly interruptions: InterruptionController;
  private readonly keypadCollector: KeypadCollector | null;
  private readonly usageAccumulator = new UsageAccumulator();
  private readonly toolQueue = new ToolResultQueue();
  private readonly transcriptEntries: TranscriptEntry[] = [];
  private toolset: Map<string, Tool>;
  private readonly startedAtMs = Date.now();
  private readonly interruptedResponses = new Set<string>();
  private readonly runningTools = new Map<string, AbortController>();
  private readonly timers = new Set<NodeJS.Timeout>();

  private provider: BaseRealtimeProvider | null = null;
  /** Primary + fallbacks, in try-order. Only walked while connecting. */
  private readonly providerChain: readonly ProviderFactory[];
  private activeAgentValue: Agent;
  private generating = false;
  private currentResponseId: string | null = null;
  private firstTurnDone = false;
  /**
   * A caller turn that a blocked barge-in swallowed. With bridge-owned
   * interruptions the server no longer auto-responds while the protected
   * response is active, so the bridge answers it after protected playback:
   * 'speaking' → user started during a block; 'committed' → their turn ended
   * (VAD committed it) and deserves a response once playback finishes.
   */
  private blockedUserTurn: 'idle' | 'speaking' | 'committed' = 'idle';
  private greeted = false;
  private answered: boolean;
  private inboundBuffer: string[] = [];
  private reconnectAttempt = 0;
  private reconnecting = false;
  private pendingHangup: {
    resolvers: Array<() => void>;
    watchdog: NodeJS.Timeout;
    /** A goodbye response began after arming — completion may proceed once idle. */
    sawResponse: boolean;
    /** Monotonic goodbye-liveness evidence: deltas sent, response starts, mark echoes. */
    progress: number;
    /** `progress` at the last watchdog check — no movement for a window = dead leg. */
    progressAtCheck: number;
    /** Model-owned turn-taking: one-gap wait for the goodbye's next sentence. */
    grace?: NodeJS.Timeout | null;
  } | null = null;
  private pendingTransfer: { phoneNumber: string; callerId?: string } | null = null;
  private endedReason: CallEndReason | null = null;
  private hangupReason: CallEndReason = 'agent-hangup';

  private readonly middlewares: readonly ToolMiddleware[];
  private readonly bgAudio: BackgroundAudioPlayer;
  /** Deferred tool calls awaiting a real result (execute() or submitToolResult). */
  private readonly deferredPending = new Map<string, { toolName: string }>();
  /** Human-in-the-loop calls awaiting approve/reject. */
  private readonly approvals = new Map<
    string,
    { call: ProviderToolCall; tool: Tool; input: unknown; timer: NodeJS.Timeout }
  >();
  /** Text turns to inject once the agent finishes speaking (deferred results). */
  private pendingInjections: Array<{ text: string; triggerResponse: boolean }> = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private nudgeCount = 0;

  /** All agents reachable from the root via handoffs, by id. */
  private readonly agents: Map<string, Agent>;
  private readonly handoffHistory: HandoffRecord[] = [];
  private handoffInProgress = false;
  /**
   * An agent that just took over cannot transfer again until the caller has
   * spoken. Without it every incoming agent re-derives intent from the same
   * replayed transcript, decides the request is not its own, and transfers on
   * — agents ping-ponging with no caller turn between them (field bug, Aug
   * 2026). Programmatic `handoffTo()` is host intent and bypasses the lock,
   * but still arms it for the agent it installs.
   */
  private handoffLockedUntilCallerTurn = false;
  /** Pre-synthesized greeting playout state. */
  private pregreeting: { text: string; durationMs: number; played: boolean } | null = null;

  /** Noise-adaptive VAD (opt-in); built after connect from the provider's ACKed config. */
  private noiseVad: NoiseAdaptiveVadController | null = null;
  /**
   * DESIRED turn-detection override — drives reconnect/handoff rebuilds via
   * buildProviderInit. Distinct from the provider's ACKed effective state:
   * manual updateVad() promotes it immediately (user intent survives network
   * failures); adaptive applies promote it only after the provider's ack.
   */
  private vadOverride: VadConfig | null | undefined = undefined;
  /** VAD mutations in flight (manual AND adaptive); proposals drop while > 0. */
  private vadOpsInFlight = 0;
  /** Bumped by every updateVad(); a stale revision means an adaptive apply was superseded. */
  private vadRevision = 0;
  private userSpeechActive = false;
  private userSpeechStartedAtMs = 0;

  constructor(deps: CallSessionDeps) {
    super();
    this.deps = deps;
    this.callSid = deps.start.start.callSid;
    this.streamSid = deps.start.start.streamSid ?? deps.start.streamSid;
    this.log = childLogger(deps.logger, { callSid: this.callSid });
    this.providerChain = [deps.providerFactory, ...(deps.fallbacks ?? [])];
    this.activeAgentValue = deps.agent;
    this.context = new SessionContext(deps.options.context);
    this.interruptions = new InterruptionController(deps.options.interruptions);
    this.keypadCollector = deps.options.keypad
      ? new KeypadCollector(deps.options.keypad, {
          onEntry: (entry) => this.onKeypadEntry(entry),
          onClear: (info) => this.onKeypadCleared(info),
        })
      : null;
    const collector = this.keypadCollector;
    this.keypad = {
      get digits() {
        return collector?.digits ?? '';
      },
      clear: () => collector?.clear(),
      submit: () => collector?.submit(),
    };

    const params = deps.start.start.customParameters ?? {};
    this.callInfo = {
      direction: params.direction === 'outbound' ? 'outbound' : 'inbound',
      from: params.from,
      to: params.to,
      customParameters: params,
    };
    this.answered = deps.answeredEarly === true || this.callInfo.direction === 'inbound';
    this.agents = collectAgentGraph(deps.agent);
    this.middlewares = deps.middlewares ?? [];
    this.bgAudio = new BackgroundAudioPlayer({
      sendMedia: (payload) => {
        if (this.stateValue === 'active' && this.deps.transport.isOpen) {
          this.deps.transport.sendMedia(payload);
        }
      },
      onStarted: (info) => this.emit('background_audio.started', info),
      onStopped: (info) => this.emit('background_audio.stopped', info),
    });
    this.toolset = this.buildToolset();
    this.wireTransport();
  }

  // ---- public surface ------------------------------------------------------

  get state(): CallState {
    return this.stateValue;
  }

  get activeAgent(): Agent {
    return this.activeAgentValue;
  }

  get usage(): UsageInfo {
    return this.usageAccumulator.snapshot();
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.transcriptEntries;
  }

  /** Connect the provider and activate the call. Called by the bridge. */
  async begin(): Promise<void> {
    // Burst-write the pre-synthesized greeting BEFORE the provider handshake:
    // the caller hears a voice within ~250ms while the model session builds.
    // (It also covers the extra latency of walking a fallback chain.)
    this.playPreGreeting();
    const connected = await this.connectInitialProvider();
    if (!connected) return; // chain exhausted (already failed) or torn down while connecting
    if (this.stateValue !== 'connecting') return; // torn down while connecting
    this.stateValue = 'active';
    this.emit('provider.connected');
    this.emit('call.started', {
      callSid: this.callSid,
      streamSid: this.streamSid,
      direction: this.callInfo.direction,
      from: this.callInfo.from,
      to: this.callInfo.to,
      customParameters: this.callInfo.customParameters,
    });
    // Noise-adaptive VAD: the ladder's baseline is what the provider actually
    // ACKed at connect (provider-level defaults and the barge-in injection
    // included) — never what the session options merely intended. An explicit
    // vad: null means turn detection is off and there is nothing to adapt.
    if (this.deps.options.noiseAdaptiveVad && this.deps.options.vad !== null) {
      this.noiseVad = new NoiseAdaptiveVadController(
        this.deps.options.noiseAdaptiveVad,
        this.provider!.getEffectiveVad(),
        this.provider!.capabilities.vadTuning,
      );
      if (this.noiseVad.exhausted) {
        this.log.warn('noiseAdaptiveVad enabled but the effective VAD config leaves no escalation room');
      }
    }
    // Seed the pre-played greeting into the model's context so it continues
    // from it instead of greeting twice (second of three no-re-greet layers;
    // the instruction reinforcement lives in buildProviderInit).
    if (this.pregreeting) {
      this.provider!.sendText(this.pregreeting.text, { role: 'assistant', triggerResponse: false });
    }
    this.flushInboundBuffer();
    this.startMaxDurationWatchdog();
    this.armIdleTimer();
    void this.saveSnapshot();
    this.maybeGreet();
  }

  /**
   * Walk primary + fallbacks until one connects. A provider that fails to
   * come up is detached BEFORE the chain advances, so a half-open socket's
   * late events can never reach the session once the next provider owns the
   * call. Connect-time only by design: once a provider has answered, the
   * call stays with it. Returns false after failing the call (chain
   * exhausted) or when the call was torn down while connecting.
   */
  private async connectInitialProvider(): Promise<boolean> {
    let lastFrom = 'provider';
    let lastError: Error | null = null;
    for (const factory of this.providerChain) {
      let provider: BaseRealtimeProvider;
      try {
        provider = factory({ logger: this.log, callSid: this.callSid });
      } catch (error) {
        lastError = toError(error);
        this.log.warn('provider factory threw — trying the next fallback', {
          error: String(lastError),
        });
        continue;
      }
      if (lastError) {
        this.emit('provider.fallback', { from: lastFrom, to: provider.name, error: lastError });
      }
      this.provider = provider;
      this.wireProvider(provider);
      try {
        await provider.connect(this.buildProviderInit());
        return true;
      } catch (error) {
        provider.removeAllListeners();
        void provider.close().catch(() => {});
        this.provider = null;
        if (this.stateValue !== 'connecting') return false; // torn down while connecting
        lastFrom = provider.name;
        lastError = toError(error);
        this.log.warn('provider failed to connect', {
          provider: provider.name,
          error: String(lastError),
        });
      }
    }
    this.fail(lastError ?? new Error('provider connect failed'), 'provider-failed');
    return false;
  }

  /** The outbound leg was answered (host's Twilio status callback). */
  notifyAnswered(): void {
    if (this.answered) return;
    this.answered = true;
    this.maybeGreet();
  }

  sendText(text: string, options: { role?: 'user' | 'system'; triggerResponse?: boolean } = {}): void {
    this.provider?.sendText(text, options);
  }

  async updateInstructions(instructions: string): Promise<void> {
    await this.provider?.updateSession({ instructions });
  }

  /**
   * Replace the session's turn-detection config mid-call. The value is the
   * new DESIRED state: it survives reconnects and handoffs, and the
   * noise-adaptive ladder (when enabled) rebases onto it — future escalation
   * is relative to this config, never below it. `null` disables turn
   * detection AND suspends noise adaptation (adaptation never re-enables VAD
   * on its own); a later non-null call re-enables both.
   *
   * Returns true when the live session applied it — provider-acknowledged
   * when `noiseAdaptiveVad` is configured (serialized updates), best-effort
   * "sent" otherwise. False when it could not be applied live (no provider,
   * call ended, no sessionUpdate capability, or the ack timed out — the
   * resulting reconnect then applies the stored config).
   */
  async updateVad(vad: VadConfig | null): Promise<boolean> {
    this.vadRevision++; // supersede any in-flight adaptive apply
    this.vadOpsInFlight++; // and block new adaptive applies while this runs
    try {
      this.vadOverride = vad; // manual intent persists even through failures
      if (!this.provider || this.stateValue === 'ended') return false;
      if (!this.provider.capabilities.sessionUpdate) {
        this.log.warn('updateVad: provider has no mid-session update — stored for the next reconnect');
        return false;
      }
      return (await this.provider.updateSession({ vad }, { awaitAck: true })) === true;
    } finally {
      this.noiseVad?.rebase(vad);
      this.vadOpsInFlight--;
    }
  }

  /** Manual barge-in: stop the agent mid-sentence. */
  interrupt(): void {
    if (!this.generating && !this.tracker.isPlaybackActive()) return;
    // A full-duplex model stops on its own the moment the caller speaks; a
    // clear here would only cut its live stream (documented, see parity tests).
    if (this.modelOwnsTurnTaking()) return;
    this.provider?.cancelResponse();
    this.performInterrupt();
  }

  /**
   * Gracefully end the call. With `finalMessage`, the agent speaks it first.
   * With `immediate: true`, skip the goodbye and complete now. Resolves when
   * the call has actually ended.
   */
  finishCall(options: { finalMessage?: string; immediate?: boolean } = {}): Promise<void> {
    if (this.stateValue === 'ended') return Promise.resolve();
    if (options.immediate) {
      this.completeHangup();
      return Promise.resolve();
    }
    if (options.finalMessage) {
      this.provider?.createResponse({
        instructions: `Say exactly this to the caller, then stop speaking: "${options.finalMessage}"`,
      });
    }
    return this.armHangup();
  }

  /** Transfer the PSTN leg. Waits for current playback (and announcement). */
  async transferTo(
    phoneNumber: string,
    options: { callerId?: string; announcement?: string } = {},
  ): Promise<void> {
    if (!this.deps.rest) {
      throw new Error('transferTo requires Twilio REST credentials (BridgeConfig.twilio)');
    }
    if (this.stateValue === 'ended' || this.stateValue === 'ending') return;
    this.pendingTransfer = {
      phoneNumber,
      callerId: options.callerId ?? this.deps.restCallerId,
    };
    if (options.announcement) {
      this.provider?.createResponse({
        instructions: `Tell the caller now, briefly: "${options.announcement}". Then stop speaking.`,
      });
      return; // executes on the announcement's playback.finished
    }
    if (this.generating || this.tracker.isPlaybackActive()) return; // executes on playback.finished
    await this.executePendingTransfer();
  }

  /** Swap the active agent (swarm handoff). Accepts an Agent or its id. */
  async handoffTo(agent: Agent | string): Promise<void> {
    const targetId = typeof agent === 'string' ? agent : agent.id;
    const target = this.agents.get(targetId);
    if (!target) {
      throw new Error(
        `unknown agent "${targetId}" — agents must be reachable from the root agent's handoffs`,
      );
    }
    await this.performHandoff(target);
  }

  /** Complete a `deferred` tool call from the host side. */
  submitToolResult(toolCallId: string, result: unknown): void {
    this.completeDeferredFromHost(toolCallId, result);
  }

  /** Start background audio manually (independent of tools). */
  async playBackgroundAudio(
    spec: BackgroundAudioSpec,
    options: BackgroundAudioOptions = {},
  ): Promise<void> {
    this.bgAudio.start(spec, { startDelayMs: 0, ...options });
  }

  async stopBackgroundAudio(options: { fadeOutMs?: number } = {}): Promise<void> {
    this.bgAudio.stop({ immediate: !options.fadeOutMs });
  }

  /** Immediate teardown (no goodbye). */
  async end(reason: CallEndReason = 'agent-hangup'): Promise<void> {
    await this.teardown(reason);
  }

  // ---- setup ---------------------------------------------------------------

  private buildToolset(): Map<string, Tool> {
    const tools = new Map<string, Tool>();
    const builtin = this.deps.builtinTools ?? {};
    if (builtin.finishCall) {
      const opts = typeof builtin.finishCall === 'object' ? builtin.finishCall : {};
      tools.set('finish_call', createFinishCallTool({
        description: opts.description,
        farewellInstruction: opts.farewellInstruction,
      }));
    }
    if (builtin.transferCall) {
      const opts = builtin.transferCall;
      tools.set('transfer_call', createTransferCallTool({
        defaultPhoneNumber: opts.defaultPhoneNumber,
        callerId: opts.callerId,
        description: opts.description,
        announcement: opts.announcement,
      }));
    }
    for (const target of this.activeAgentValue.handoffs) {
      const handoffTool = createHandoffTool(target);
      tools.set(handoffTool.name, handoffTool);
    }
    for (const tool of this.activeAgentValue.tools) {
      if (tools.has(tool.name)) {
        this.log.warn(`agent tool "${tool.name}" overrides a builtin of the same name`);
      }
      tools.set(tool.name, tool);
    }
    return tools;
  }

  /** Agent instructions plus the kit's own notes that must survive handoffs (keypad). */
  private composeInstructions(): string {
    const base = this.activeAgentValue.resolveInstructions(this.context);
    const keypad = this.deps.options.keypad;
    if (!keypad || keypad.instructions === false) return base;
    return `${base}\n\n${keypad.instructions ?? DEFAULT_KEYPAD_INSTRUCTIONS}`;
  }

  private buildProviderInit(): ProviderSessionInit {
    return {
      instructions:
        this.composeInstructions() +
        (this.pregreeting
          ? `\n\nYou already opened the call by saying: "${this.pregreeting.text}". Do not greet again — continue the conversation from there.`
          : ''),
      voice: this.activeAgentValue.voice,
      // A runtime override (updateVad / committed noise adaptation) survives
      // reconnects and handoff-reconnects — this rebuild is their vehicle.
      vad: this.vadOverride !== undefined ? this.vadOverride : this.deps.options.vad,
      // The guard must be able to VETO an interruption, which requires the
      // server not to auto-cancel on speech onset. Capability-gated inside
      // each provider; explicit vad.interruptResponse wins.
      bridgeOwnsInterruptions: true,
      // Noise adaptation needs acknowledged, serialized session updates;
      // without it the legacy fire-and-forget behavior stays untouched.
      serializedSessionUpdates: this.deps.options.noiseAdaptiveVad !== undefined,
      tools: [...this.toolset.values()].map((tool) => {
        const decorated = decorateTool(tool, this.middlewares);
        return {
          name: tool.name,
          description: decorated.description,
          parameters: decorated.parameters,
        };
      }),
      providerOptions: this.activeAgentValue.providerOptions,
      // Providers with `startupHistory` seed this into the new session
      // (reconnects, handoff-reconnects); the others re-inject it as text.
      history: this.buildHistory(),
    };
  }

  /** Whether the connected provider decides turn-taking itself (full-duplex). */
  private modelOwnsTurnTaking(): boolean {
    return this.provider?.capabilities.turnTaking === 'model';
  }

  /** Attributed replay of the call so far, as turns (see buildHistoryForSeeding). */
  private buildHistory(): ProviderHistoryEntry[] | undefined {
    if (this.transcriptEntries.length === 0) return undefined;
    const turns = buildHistoryForSeeding(this.transcriptEntries, {
      agentNames: new Map([...this.agents].map(([id, agent]) => [id, agent.name])),
      handoffs: this.handoffHistory,
    });
    return [
      {
        role: 'developer',
        text:
          `Context: this phone call reconnected mid-conversation. You are ${this.activeAgentValue.name}. ` +
          `The conversation so far follows: assistant lines that name another agent were said by that ` +
          `agent, and \`[transfer]\` notes are routing that ALREADY happened. Anything already answered ` +
          `or already routed must not be routed again. Continue naturally from where it left off; ` +
          `do not greet again.`,
      },
      ...turns,
    ];
  }

  private wireTransport(): void {
    const { transport } = this.deps;
    transport.on('media', (event) => this.handleInboundMedia(event.media.payload));
    transport.on('mark', (event) => this.handleMarkEcho(event.mark.name));
    transport.on('dtmf', (event) => {
      this.clearIdleTimer();
      this.nudgeCount = 0;
      const digit = event.dtmf.digit;
      // The collector consumes the key BEFORE the raw event fires: a host
      // listener sees `session.keypad.digits` already updated and can
      // `clear()` a key it decides to handle itself.
      this.handleKeypress(digit);
      this.emit('dtmf', { digit });
    });
    // A stop/close that arrives while we are completing our own hangup is
    // Twilio confirming the REST completion, not the caller leaving.
    transport.on('stop', () => void this.teardown(this.stateValue === 'ending' ? this.hangupReason : 'caller-hangup'));
    transport.on('close', () => void this.teardown(this.stateValue === 'ending' ? this.hangupReason : 'caller-hangup'));
    transport.on('error', (error) => this.emitError(error));
  }

  /** Emit 'error'; when the host attached no listener, log instead of losing it. */
  private emitError(error: Error): void {
    if (this.listenerCount('error') === 0) {
      this.log.error('session error (no "error" listener attached)', { error: String(error) });
    }
    this.emit('error', error);
  }

  private wireProvider(provider: BaseRealtimeProvider): void {
    provider.on('audio', (delta) => {
      if (this.stateValue !== 'active' && this.stateValue !== 'ending') return;
      if (!this.deps.transport.isOpen) return;
      // With bridge-owned cancels, deltas already in flight when we cancelled
      // keep arriving for a round-trip — forwarding them would queue stale
      // speech behind the clear we just sent.
      if (this.interruptedResponses.has(delta.responseId)) return;
      // Real agent speech preempts any hold loop instantly (no fade, no clear:
      // clearing would flush this very delta out of Twilio's buffer).
      this.bgAudio.notifyAgentAudio();
      this.deps.transport.sendMedia(delta.base64Mulaw);
      this.noteHangupProgress(); // goodbye audio still flowing — not a dead leg
      const chunkMs = base64ByteLength(delta.base64Mulaw) / 8;
      // Checkpoint marks only (first chunk / ~1s interval / final): per-delta
      // marks audibly degraded Twilio playback in the field.
      const markName = this.tracker.onAudioSent(delta.responseId, chunkMs, delta.itemId);
      if (markName) this.deps.transport.sendMark(markName);
    });

    provider.on('responseStarted', ({ responseId }) => {
      this.generating = true;
      this.currentResponseId = responseId;
      this.blockedUserTurn = 'idle'; // something is answering the caller

      if (this.pendingHangup) {
        this.pendingHangup.sawResponse = true;
        if (this.pendingHangup.grace) {
          clearTimeout(this.pendingHangup.grace);
          this.timers.delete(this.pendingHangup.grace);
          this.pendingHangup.grace = null;
        }
      }
      this.noteHangupProgress(); // the goodbye began — give it a fresh window
      this.clearIdleTimer();
      this.interruptions.onResponseStarted(responseId);
      this.emit('agent.speech.started', { responseId });
    });

    provider.on('responseDone', ({ responseId, usage }) => {
      this.generating = false;
      // The tail checkpoint closes the response's mark ledger; without it
      // playback.finished (and everything gated on it) never fires.
      const tailMark = this.tracker.onGenerationDone(responseId);
      if (tailMark && this.deps.transport.isOpen) this.deps.transport.sendMark(tailMark);
      this.emit('agent.speech.ended', { responseId });
      if (usage) {
        const total = this.usageAccumulator.add(usage);
        this.emit('usage.updated', total, usage);
      }
      // A response with no audio produces no marks — settle dependents now.
      if (!this.tracker.isPlaybackActive()) {
        // A silent turn with no tool work concludes the first turn — deafness
        // must not wait for audio that never comes. With tool work pending,
        // the post-tool response is the audible first turn; let its playback
        // set the flag so the greeting keeps its protection.
        if (this.runningTools.size === 0 && this.toolQueue.size === 0) {
          this.firstTurnDone = true;
        }
        // Nothing is (or will be) playing: release the guard's playback hold
        // so deferred guard rotations apply (see InterruptionController).
        this.interruptions.onPlaybackEnded();
        this.flushToolQueue();
        void this.executePendingTransfer();
        this.maybeCompleteHangup();
      }
    });

    provider.on('agentTranscript', ({ responseId, text }) => {
      const entry: TranscriptEntry = {
        role: 'agent',
        text,
        timestampMs: Date.now() - this.startedAtMs,
        agentId: this.activeAgentValue.id,
        ...(this.interruptedResponses.has(responseId) ? { interrupted: true } : {}),
      };
      this.transcriptEntries.push(entry);
      this.emit('transcript.agent', entry);
    });

    provider.on('userTranscript', ({ text }) => {
      const entry: TranscriptEntry = {
        role: 'user',
        text,
        timestampMs: Date.now() - this.startedAtMs,
      };
      this.transcriptEntries.push(entry);
      this.nudgeCount = 0;
      this.handoffLockedUntilCallerTurn = false;
      this.emit('transcript.user', entry);
    });

    provider.on('userSpeechStarted', () => {
      this.userSpeechActive = true;
      this.userSpeechStartedAtMs = Date.now();
      this.handoffLockedUntilCallerTurn = false;
      this.clearIdleTimer();
      this.nudgeCount = 0;
      this.emit('user.speech.started');
      this.handleBargeIn();
    });
    provider.on('userSpeechStopped', () => {
      this.userSpeechActive = false;
      // Their blocked turn is now VAD-committed server-side; answer it once
      // the protected playback finishes.
      if (this.blockedUserTurn === 'speaking') this.blockedUserTurn = 'committed';
      this.emit('user.speech.ended');
    });

    provider.on('toolCall', (call) => void this.handleToolCall(call));

    provider.on('usage', (usage) => {
      // Response-bound providers report usage on responseDone (accounted
      // there; their `usage` event is for host listeners). A decoupled backend
      // has no response boundary carrying usage — duration ticks and backend
      // completions arrive here and only here.
      if (!provider.capabilities.decoupledBackend) return;
      const total = this.usageAccumulator.add(usage);
      this.emit('usage.updated', total, usage);
    });

    provider.on('error', (error) => this.emitError(error));

    provider.on('close', (info) => {
      if (this.stateValue === 'ended' || this.stateValue === 'ending') return;
      if (this.handoffInProgress) return; // deliberate close-and-reopen
      this.emit('provider.closed', { code: info.code, reason: info.reason });
      if (!info.retriable) {
        this.fail(new Error(`provider closed (${info.code} ${info.reason ?? ''})`), 'provider-failed');
        return;
      }
      this.scheduleReconnect();
    });
  }

  // ---- inbound audio -------------------------------------------------------

  private handleInboundMedia(inbound: string): void {
    let payload = inbound;
    if (this.stateValue === 'ended' || this.stateValue === 'ending') return;
    // The noise meter taps BEFORE the drop-guards below: rate-limiter
    // suspension and first-turn deafness are consequences of noise, so a
    // meter behind them would go blind exactly when it matters. Caller
    // speech, agent playback (speakerphone bleed), and the pre-greeting are
    // excluded from the floor estimate instead — they are sound, not line
    // noise. `flushInboundBuffer` bypasses this tap, so buffered frames are
    // metered exactly once, at arrival.
    if (this.noiseVad) {
      const excluded =
        this.isUserSpeechExcluded() ||
        this.tracker.isPlaybackActive() ||
        (this.pregreeting !== null && !this.pregreeting.played);
      const proposal = this.noiseVad.onInboundFrame(payload, excluded);
      if (proposal) this.handleVadProposal(proposal);
    }
    // While the pre-synthesized greeting is playing, the provider must not
    // hear the line: server-side VAD would treat greeting bleed/noise as a
    // barge-in on a turn it never generated.
    const deaf =
      (this.pregreeting !== null && !this.pregreeting.played) ||
      (this.deps.options.deafness.ignoreUserAudioUntilFirstTurnDone && !this.firstTurnDone) ||
      (this.deps.options.deafness.muteDuringToolExecution && this.runningTools.size > 0) ||
      (this.deps.options.deafness.muteWhileAgentSpeaking && this.tracker.isPlaybackActive()) ||
      this.interruptions.isSuspended;
    if (deaf) {
      // A full-duplex model's session clock runs on input audio: dropping
      // frames would stall its appends (greeting included). Feed it silence
      // of the same length instead — deaf, but ticking.
      if (!this.modelOwnsTurnTaking()) return;
      payload = silenceLike(payload);
    }

    if (this.provider?.isConnected && !this.reconnecting) {
      this.provider.sendAudio(payload);
    } else {
      this.inboundBuffer.push(payload);
      if (this.inboundBuffer.length > MAX_BUFFERED_INBOUND_FRAMES) this.inboundBuffer.shift();
    }
  }

  private flushInboundBuffer(): void {
    if (!this.provider?.isConnected) return;
    // A real-time model lives on its own clock: a burst of buffered frames
    // would arrive faster than time passes. The gap is covered by hold audio
    // and the seeded history; the frames themselves are dropped.
    if (!this.modelOwnsTurnTaking()) {
      for (const payload of this.inboundBuffer) this.provider.sendAudio(payload);
    }
    this.inboundBuffer = [];
  }

  // ---- noise-adaptive VAD ---------------------------------------------------

  /** Caller speech is excluded from the noise floor, capped so a missing
   * speech-stopped event (Gemini) can't latch the meter off forever. */
  private isUserSpeechExcluded(): boolean {
    return this.userSpeechActive && Date.now() - this.userSpeechStartedAtMs < MAX_SPEECH_EXCLUSION_MS;
  }

  private handleVadProposal(proposal: VadAdjustment): void {
    if (this.vadOpsInFlight > 0) return; // one VAD mutation at a time (manual included)
    const mode = this.deps.options.noiseAdaptiveVad?.mode ?? 'auto';
    const willAutoApply =
      mode === 'auto' && proposal.autoApplicable && this.provider?.capabilities.sessionUpdate === true;
    this.emit('vad.suggestion', { ...proposal, willAutoApply });
    if (!willAutoApply) {
      // Suggestion-only: suggest mode, a rung that is never auto-applied
      // (semantic/sensitivity), or no mid-session update on this provider
      // (the documented Gemini fallback). Fires once per effective state;
      // the effective config is NOT moved — a suggestion is not reality.
      this.noiseVad?.markSuggested(proposal);
      return;
    }
    this.vadOpsInFlight++;
    const revisionAtPropose = this.vadRevision;
    void this.applyAdaptiveVadUpdate(proposal, revisionAtPropose)
      .catch((error) => {
        this.noiseVad?.defer();
        this.log.warn('noise-adaptive VAD apply failed', { error: String(error) });
      })
      .finally(() => {
        this.vadOpsInFlight--;
      });
  }

  /**
   * Adaptive applies promote NOTHING until the provider ACKs: a timed-out
   * update must not leak into vadOverride, or the desync-reconnect would
   * apply a config the controller never committed (dual truth). Contrast
   * with updateVad(), where the user's declared intent persists regardless.
   */
  private async applyAdaptiveVadUpdate(proposal: VadAdjustment, revisionAtPropose: number): Promise<void> {
    const provider = this.provider;
    if (!provider || this.stateValue === 'ended') {
      this.noiseVad?.defer();
      return;
    }
    const acked = await provider.updateSession({ vad: proposal.suggested }, { awaitAck: true });
    if (revisionAtPropose !== this.vadRevision) return; // superseded by updateVad()
    if (acked === true) {
      this.vadOverride = proposal.suggested;
      this.noiseVad?.commitApplied(proposal);
      this.emit('vad.adjusted', proposal);
    } else {
      this.noiseVad?.defer();
    }
  }

  // ---- playback / marks ----------------------------------------------------

  private handleMarkEcho(name: string): void {
    if (name === PREGREETING_MARK) {
      if (this.pregreeting && !this.pregreeting.played) {
        this.pregreeting.played = true;
        // The pre-played greeting IS the agent's first turn: without this,
        // first-turn deafness would outlive it (auto-greet is suppressed,
        // so no model turn ever comes to lift it) and deafen the call.
        this.firstTurnDone = true;
        this.emit('playback.finished', {
          responseId: 'pregreeting',
          playedMs: this.pregreeting.durationMs,
        });
        this.armIdleTimer();
      }
      return;
    }
    if (!PlaybackTracker.isTrackedMark(name)) return;
    const result = this.tracker.onMarkEcho(name);
    if (!result) return;
    // Any tracked echo proves the Twilio leg is alive and playing out
    // (background-audio marks are already filtered by isTrackedMark).
    this.noteHangupProgress();
    if (result.kind === 'flushed') return;
    if (result.playbackStarted) {
      this.emit('playback.started', { responseId: result.responseId });
      this.interruptions.onPlaybackStarted(result.responseId);
    }
    if (result.playbackFinished) {
      this.onPlaybackFinished(result.responseId, result.playedMs);
    }
  }

  private onPlaybackFinished(responseId: string, playedMs: number): void {
    this.emit('playback.finished', { responseId, playedMs });
    this.firstTurnDone = true;
    this.interruptions.onPlaybackEnded();
    const hadQueuedToolResults = this.toolQueue.size > 0;
    this.flushToolQueue();
    void this.executePendingTransfer();
    this.maybeCompleteHangup();
    // A turn the guard swallowed mid-playback gets its answer now. The
    // server-side auto-response skipped it (a response was active at commit
    // time), and `responseStarted` clears the flag if anything answered since.
    // Tool activity triggers its own response covering the whole conversation
    // (the swallowed turn included) — creating here too would double-respond.
    if (this.blockedUserTurn === 'committed') {
      this.blockedUserTurn = 'idle';
      if (!hadQueuedToolResults && this.runningTools.size === 0) this.provider?.createResponse();
    }
    this.armIdleTimer();
  }

  // ---- interruption --------------------------------------------------------

  private handleBargeIn(): void {
    if (!this.generating && !this.tracker.isPlaybackActive()) return;
    if (this.modelOwnsTurnTaking()) return; // the model already yielded (or chose not to)
    const decision = this.interruptions.evaluate({ toolRunning: this.runningTools.size > 0 });
    if (!decision.allow) {
      // Nothing is cancelled and nothing is cleared: on providers with
      // vadInterruptControl the agent genuinely keeps talking. Remember the
      // swallowed turn so the caller still gets an answer afterwards.
      if (decision.cause === 'guard' || decision.cause === 'disabled') {
        this.blockedUserTurn = 'speaking';
      }
      this.emit('interruption.blocked', { cause: decision.cause });
      if (decision.instruction) {
        this.provider?.sendText(decision.instruction, { role: 'system', triggerResponse: true });
      }
      return;
    }
    // Bridge-owned interruption: we cancel generation ourselves (server-side
    // auto-interrupt is disabled where the provider supports it), then kill
    // playback. Fallback providers' servers already cancelled on speech
    // onset — an extra cancel from us would just race and error.
    if (this.generating && this.provider?.capabilities.vadInterruptControl) {
      this.provider.cancelResponse();
    }
    this.performInterrupt();
  }

  private performInterrupt(): void {
    const active = this.tracker.snapshotActive();
    this.tracker.onClear();
    // The flush ends whatever was playing — release the guard's playback
    // hold so deferred guard rotations apply to the responses that follow.
    this.interruptions.onPlaybackEnded();
    if (this.deps.transport.isOpen) this.deps.transport.sendClear();
    for (const response of active) {
      this.interruptedResponses.add(response.responseId);
      if (this.provider?.capabilities.truncate && response.itemId) {
        this.provider.truncatePlayback(response.itemId, response.estimatedPlayedMs);
      }
      this.emit('playback.interrupted', {
        responseId: response.responseId,
        playedMs: response.estimatedPlayedMs,
      });
      this.emit('interruption', {
        responseId: response.responseId,
        playedMs: response.estimatedPlayedMs,
      });
    }
    // Anything queued behind the flushed audio can go out now.
    this.flushToolQueue();
    // A barge-in that flushed the goodbye means the caller talked over the
    // farewell — its playout will never confirm; complete now instead of
    // burning the hangup watchdog on dead air.
    if (this.pendingHangup?.sawResponse) this.completeHangup();
  }

  // ---- tools ---------------------------------------------------------------

  private async handleToolCall(call: ProviderToolCall): Promise<void> {
    const tool = this.toolset.get(call.name);
    const started = Date.now();
    const baseInfo = {
      toolCallId: call.id,
      toolName: call.name,
      agentId: this.activeAgentValue.id,
    };

    if (!tool) {
      this.log.warn(`model called unknown tool "${call.name}"`);
      this.emit('tool.failed', { ...baseInfo, strategy: 'unknown', error: 'unknown tool' });
      this.deliverToolResult(call.id, { error: `Unknown tool: ${call.name}` });
      return;
    }

    let rawInput: unknown;
    try {
      rawInput = call.argumentsJson.trim() === '' ? {} : JSON.parse(call.argumentsJson);
    } catch {
      this.deliverToolResult(call.id, {
        error: 'invalid_arguments',
        message: 'Tool arguments were not valid JSON. Retry with corrected arguments.',
      });
      this.emit('tool.failed', { ...baseInfo, strategy: tool.strategy, error: 'invalid JSON arguments' });
      return;
    }

    const parsed = tool.parameters.safeParse(rawInput);
    if (!parsed.success) {
      this.deliverToolResult(call.id, {
        error: 'validation_failed',
        message: 'Tool arguments failed validation. Fix them and retry.',
        issues: (parsed as { error?: { issues?: unknown[] } }).error?.issues ?? [],
      });
      this.emit('tool.failed', { ...baseInfo, strategy: tool.strategy, error: 'argument validation failed' });
      return;
    }

    const input = parsed.data;
    this.emit('tool.started', { ...baseInfo, strategy: tool.strategy, input });

    switch (tool.strategy) {
      case 'sync':
        await this.runForegroundTool(tool, call, input, started);
        break;

      case 'dispatch': {
        // Fire-and-forget: the model gets an immediate ack and keeps talking.
        this.deliverToolResult(call.id, {
          status: 'queued',
          note: 'The task was dispatched and runs in the background. Continue the conversation naturally; do not mention internal processing.',
        });
        void this.runDetachedTool(tool, call, input, started, (outcome) => {
          if (outcome.ok) {
            this.emit('tool.completed', {
              ...baseInfo,
              strategy: tool.strategy,
              input,
              result: outcome.result,
              durationMs: Date.now() - started,
            });
          } else {
            this.emit('tool.failed', {
              ...baseInfo,
              strategy: tool.strategy,
              error: outcome.message,
              durationMs: Date.now() - started,
            });
          }
        });
        break;
      }

      case 'deferred': {
        // The model acknowledges and keeps talking; the real result is
        // injected as a new turn when it arrives (from execute() OR from
        // session.submitToolResult(), whichever comes first).
        this.deferredPending.set(call.id, { toolName: call.name });
        this.deliverToolResult(call.id, {
          status: 'pending',
          note: 'The result is being prepared and will arrive shortly as a system message. Tell the caller you are looking into it and continue naturally.',
        });
        void this.runDetachedTool(tool, call, input, started, (outcome) => {
          if (outcome.ok) {
            this.completeDeferred(call.id, call.name, outcome.result);
            this.emit('tool.completed', {
              ...baseInfo,
              strategy: tool.strategy,
              input,
              result: outcome.result,
              durationMs: Date.now() - started,
            });
          } else {
            this.completeDeferred(call.id, call.name, { error: outcome.message });
            this.emit('tool.failed', {
              ...baseInfo,
              strategy: tool.strategy,
              error: outcome.message,
              durationMs: Date.now() - started,
            });
          }
        });
        break;
      }

      case 'humanInTheLoop':
        this.requestApproval(tool, call, input);
        break;
    }
  }

  /** sync path (also the approved HITL path): hold audio, execute, deliver. */
  private async runForegroundTool(
    tool: Tool,
    call: ProviderToolCall,
    input: unknown,
    started: number,
  ): Promise<void> {
    const baseInfo = { toolCallId: call.id, toolName: call.name, agentId: this.activeAgentValue.id };
    this.acquireHoldAudio(call.id, tool);
    try {
      const outcome = await this.executeToolBody(tool, call, input);
      if (outcome.ok && isHandoffDirective(outcome.result)) {
        const directive = outcome.result;
        const target = this.agents.get(directive.targetAgentId);
        if (!target) {
          this.deliverToolResult(call.id, { error: `unknown agent "${directive.targetAgentId}"` });
          return;
        }
        if (this.handoffLockedUntilCallerTurn) {
          this.rejectHandoff(target, directive.reason, call.id);
          this.emit('tool.completed', {
            ...baseInfo,
            strategy: tool.strategy,
            input,
            result: { handoffBlocked: target.id },
            durationMs: Date.now() - started,
          });
          return;
        }
        // Settle the function call first (no response yet), then swap agents —
        // performHandoff triggers the continuation response itself.
        this.deliverToolResult(call.id, {
          status: 'transferring_conversation',
          to: target.name,
        }, false);
        this.emit('tool.completed', {
          ...baseInfo,
          strategy: tool.strategy,
          input,
          result: { handoffTo: target.id },
          durationMs: Date.now() - started,
        });
        await this.performHandoff(target, directive.reason);
        return;
      }
      if (outcome.ok) {
        this.deliverToolResult(call.id, outcome.result ?? { ok: true });
        this.emit('tool.completed', {
          ...baseInfo,
          strategy: tool.strategy,
          input,
          result: outcome.result,
          durationMs: Date.now() - started,
        });
        void this.saveSnapshot();
      } else {
        this.deliverToolResult(call.id, outcome.payload);
        this.emit('tool.failed', {
          ...baseInfo,
          strategy: tool.strategy,
          error: outcome.message,
          durationMs: Date.now() - started,
        });
      }
    } finally {
      this.bgAudio.release(call.id);
    }
  }

  /** dispatch/deferred body — no hold audio (the model keeps talking). */
  private async runDetachedTool(
    tool: Tool,
    call: ProviderToolCall,
    input: unknown,
    _started: number,
    onOutcome: (outcome: ToolOutcome) => void,
  ): Promise<void> {
    const outcome = await this.executeToolBody(tool, call, input);
    onOutcome(outcome);
  }

  /** Shared execution core: abort/timeout, middleware onion, per-tool hooks. */
  private async executeToolBody(
    tool: Tool,
    call: ProviderToolCall,
    initialInput: unknown,
  ): Promise<ToolOutcome> {
    const controller = new AbortController();
    this.runningTools.set(call.id, controller);
    const timeoutMs = tool.timeoutMs ?? 15_000;
    const timeout = setTimeout(() => controller.abort(new Error('tool timed out')), timeoutMs);
    this.timers.add(timeout);
    const ctx = this.buildToolContext(call.id, controller.signal);
    try {
      let input = initialInput;
      const innermost = async (): Promise<unknown> => {
        if (tool.onBeforeExecute) {
          const replaced = await tool.onBeforeExecute(input, ctx);
          if (replaced !== undefined) input = replaced;
        }
        let result: unknown = await this.raceAbort(
          Promise.resolve(tool.execute(input, ctx)),
          controller.signal,
        );
        if (tool.onAfterExecute) {
          const replaced = await tool.onAfterExecute(result, ctx);
          if (replaced !== undefined) result = replaced;
        }
        return result;
      };
      const result = await composeExecution(tool, input, ctx, this.middlewares, innermost);
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let payload: unknown = { error: 'tool_failed', message };
      if (tool.onError) {
        try {
          const replaced = await tool.onError(error, ctx);
          if (replaced !== undefined) payload = replaced;
        } catch {
          /* onError itself failed; keep the generic payload */
        }
      }
      return { ok: false, payload, message };
    } finally {
      clearTimeout(timeout);
      this.timers.delete(timeout);
      this.runningTools.delete(call.id);
    }
  }

  // ---- deferred + human-in-the-loop ---------------------------------------

  /** Inject a deferred result as a conversation turn (idempotent per call). */
  private completeDeferred(callId: string, toolName: string, result: unknown): void {
    if (!this.deferredPending.delete(callId)) return; // already completed
    if (this.stateValue === 'ended') return;
    const text = `[Tool "${toolName}" finished] Result: ${safeJsonStringify(result)}. Share what is relevant with the caller now.`;
    this.injectOrQueueText(text, true);
  }

  /** Complete a deferred tool from the host (webhook, operator console…). */
  private completeDeferredFromHost(toolCallId: string, result: unknown): void {
    const pending = this.deferredPending.get(toolCallId);
    if (!pending) {
      this.log.warn('submitToolResult for unknown/settled tool call', { toolCallId });
      return;
    }
    this.completeDeferred(toolCallId, pending.toolName, result);
  }

  private requestApproval(tool: Tool, call: ProviderToolCall, input: unknown): void {
    const timeoutMs = tool.approvalTimeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      this.rejectTool(call.id, 'approval timed out');
    }, timeoutMs);
    timer.unref?.();
    this.timers.add(timer);
    this.approvals.set(call.id, { call, tool, input, timer });
    // The caller waits in silence while a human decides — hold audio matters.
    this.acquireHoldAudio(call.id, tool);
    this.emit('tool.approval.required', {
      approvalId: call.id,
      toolCallId: call.id,
      toolName: call.name,
      input,
      agentId: this.activeAgentValue.id,
      expiresAtMs: Date.now() + timeoutMs,
    });
  }

  /** Approve a pending humanInTheLoop tool call (optionally editing input). */
  approveTool(approvalId: string, editedInput?: unknown): void {
    const entry = this.approvals.get(approvalId);
    if (!entry) {
      this.log.warn('approveTool for unknown approval', { approvalId });
      return;
    }
    this.approvals.delete(approvalId);
    clearTimeout(entry.timer);
    this.timers.delete(entry.timer);
    void this.runForegroundTool(
      entry.tool,
      entry.call,
      editedInput !== undefined ? editedInput : entry.input,
      Date.now(),
    );
  }

  /** Reject a pending humanInTheLoop tool call. */
  rejectTool(approvalId: string, reason?: string): void {
    const entry = this.approvals.get(approvalId);
    if (!entry) return;
    this.approvals.delete(approvalId);
    clearTimeout(entry.timer);
    this.timers.delete(entry.timer);
    this.bgAudio.release(approvalId);
    this.deliverToolResult(approvalId, {
      error: 'rejected',
      message: reason ?? 'A human operator declined this action. Tell the caller it cannot be done right now.',
    });
    this.emit('tool.failed', {
      toolCallId: approvalId,
      toolName: entry.call.name,
      strategy: entry.tool.strategy,
      agentId: this.activeAgentValue.id,
      error: reason ?? 'rejected by operator',
    });
  }

  private acquireHoldAudio(holderId: string, tool: Tool): void {
    if (tool.backgroundAudio === false) return;
    const sessionDefault = this.deps.options.toolBackgroundAudio;
    const spec: BackgroundAudioSpec | undefined = tool.backgroundAudio ?? sessionDefault?.spec;
    if (!spec) return;
    this.bgAudio.acquire(holderId, spec, {
      volume: sessionDefault?.volume,
      fadeInMs: sessionDefault?.fadeInMs,
      fadeOutMs: sessionDefault?.fadeOutMs,
      startDelayMs: sessionDefault?.startDelayMs,
      maxDurationMs: sessionDefault?.maxDurationMs,
    });
  }

  /** Inject a text turn now, or after the agent finishes speaking. */
  private injectOrQueueText(text: string, triggerResponse: boolean): void {
    // A decoupled backend keeps the conversation going while it works —
    // nothing to wait for, and waiting would only delay the answer.
    if (
      !this.provider?.capabilities.decoupledBackend &&
      (this.generating || this.tracker.isPlaybackActive())
    ) {
      this.pendingInjections.push({ text, triggerResponse });
      return;
    }
    this.provider?.sendText(text, { role: 'system', triggerResponse });
  }

  private raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private deliverToolResult(callId: string, payload: unknown, triggerResponse = true): void {
    if (this.stateValue === 'ended') return;
    if (
      this.deps.options.toolResultDelivery === 'afterPlayback' &&
      !this.provider?.capabilities.decoupledBackend &&
      (this.generating || this.tracker.isPlaybackActive())
    ) {
      this.toolQueue.enqueue({ callId, toolName: '', payload, triggerResponse });
      return;
    }
    this.provider?.sendToolResult(callId, payload, { triggerResponse });
  }

  private flushToolQueue(): void {
    if (this.stateValue === 'ended' || !this.provider?.isConnected) return;
    // One response covers every drained result, so only the last send may
    // trigger it — per-item triggers would be N back-to-back response.creates,
    // and the GA API rejects a create while the previous response is active.
    // (Providers that auto-continue after tool results ignore the flag.)
    const items = this.toolQueue.drain();
    const wantTrigger = items.some((item) => item.triggerResponse);
    for (const [index, item] of items.entries()) {
      this.provider.sendToolResult(item.callId, item.payload, {
        triggerResponse: wantTrigger && index === items.length - 1,
      });
    }
    const injections = this.pendingInjections;
    this.pendingInjections = [];
    for (const injection of injections) {
      this.provider.sendText(injection.text, {
        role: 'system',
        triggerResponse: injection.triggerResponse,
      });
    }
  }

  private buildToolContext(toolCallId: string, signal: AbortSignal): ToolContext {
    const session: CallSessionFacade = {
      callSid: this.callSid,
      sendText: (text, options) => this.sendText(text, options),
      finishCall: (options) => this.finishCall(options),
      transferTo: (phoneNumber, options) => this.transferTo(phoneNumber, options),
      handoffTo: (agent) => this.handoffTo(agent),
      playBackgroundAudio: (spec, options) => this.playBackgroundAudio(spec, options),
      stopBackgroundAudio: (options) => this.stopBackgroundAudio(options),
      submitToolResult: (id, result) => this.submitToolResult(id, result),
    };
    return {
      callSid: this.callSid,
      agent: this.activeAgentValue,
      session,
      context: this.context,
      callInfo: this.callInfo,
      logger: this.log,
      signal,
      toolCallId,
    };
  }

  // ---- greeting ------------------------------------------------------------

  private maybeGreet(): void {
    if (this.greeted) return;
    if (this.pregreeting) {
      // Third no-re-greet layer: the greeting already played from disk.
      this.greeted = true;
      return;
    }
    if (this.deps.options.greeting.mode !== 'agent-initiates') return;
    if (!this.provider?.isConnected) return;
    if (this.callInfo.direction === 'outbound' && !this.answered) return;
    this.greeted = true;
    this.provider.createResponse(
      this.deps.options.greeting.instructions
        ? { instructions: this.deps.options.greeting.instructions }
        : {},
    );
  }

  // ---- hangup / transfer ---------------------------------------------------

  private armHangup(): Promise<void> {
    if (this.pendingHangup) {
      return new Promise((resolve) => this.pendingHangup!.resolvers.push(resolve));
    }
    this.pendingHangup = {
      resolvers: [],
      watchdog: this.armHangupWatchdog(),
      sawResponse: false,
      progress: 0,
      progressAtCheck: 0,
    };
    return new Promise((resolve) => this.pendingHangup!.resolvers.push(resolve));
  }

  /** Evidence the goodbye is alive (generating or playing) — feeds the watchdog. */
  private noteHangupProgress(): void {
    if (this.pendingHangup) this.pendingHangup.progress++;
  }

  /**
   * Watchdog: forces completion only after a full quiet window — no deltas, no
   * response start, no mark echoes for `markTimeoutMs`. Evidence re-arms it, so
   * a slow or long goodbye is NEVER truncated mid-playout (wall-clock must not
   * override live mark evidence); a dead socket or a model that never says
   * goodbye still completes within one or two quiet windows.
   */
  private armHangupWatchdog(): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const pending = this.pendingHangup;
      if (!pending) return;
      if (pending.progress !== pending.progressAtCheck) {
        pending.progressAtCheck = pending.progress;
        pending.watchdog = this.armHangupWatchdog();
        return;
      }
      this.log.warn('hangup watchdog fired — no goodbye progress for a full window');
      this.completeHangup();
    }, this.deps.options.hangup.markTimeoutMs);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  private maybeCompleteHangup(): void {
    if (!this.pendingHangup) return;
    // Wait for the goodbye: a response begun after arming must fully play.
    // Without this, the tool-call response's own done event would race the
    // farewell and hang up mid-flow. The watchdog covers "no goodbye ever".
    if (!this.pendingHangup.sawResponse) return;
    if (this.generating || this.tracker.isPlaybackActive()) return;
    if (this.modelOwnsTurnTaking()) {
      // Utterance boundaries are synthesized from the audio stream, and a
      // sentence pause can split a goodbye in two (field: 0.9 s pauses,
      // Sept 2026). Playback evidence still gates completion; this only
      // waits one gap for the next sentence — a new utterance cancels it.
      if (this.pendingHangup.grace) return;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        const pending = this.pendingHangup;
        if (!pending) return;
        pending.grace = null;
        if (this.generating || this.tracker.isPlaybackActive()) return; // the next sentence took over
        this.completeHangup();
      }, HANGUP_SENTENCE_GRACE_MS);
      timer.unref?.();
      this.timers.add(timer);
      this.pendingHangup.grace = timer;
      return;
    }
    this.completeHangup();
  }

  private completeHangup(): void {
    const pending = this.pendingHangup;
    if (pending) {
      clearTimeout(pending.watchdog);
      this.timers.delete(pending.watchdog);
    }
    this.pendingHangup = null;
    if (this.stateValue === 'ended') {
      pending?.resolvers.forEach((resolve) => resolve());
      return;
    }
    this.stateValue = 'ending';
    const rest = this.deps.rest;
    const reason = this.hangupReason;
    const finish = () =>
      void this.teardown(reason).then(() => {
        pending?.resolvers.forEach((resolve) => resolve());
      });
    if (rest) {
      rest
        .completeCall(this.callSid)
        .catch((error) => this.log.warn('REST hangup failed; closing stream only', { error: String(error) }))
        .finally(finish);
    } else {
      finish();
    }
  }

  private async executePendingTransfer(): Promise<void> {
    const transfer = this.pendingTransfer;
    if (!transfer || !this.deps.rest) return;
    if (this.generating || this.tracker.isPlaybackActive()) return;
    if (this.stateValue !== 'active') return;
    this.pendingTransfer = null;
    this.stateValue = 'ending';
    try {
      await this.deps.rest.transferCall(this.callSid, transfer.phoneNumber, {
        callerId: transfer.callerId,
      });
      await this.teardown('transferred');
    } catch (error) {
      this.stateValue = 'active';
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      this.log.error('transfer failed; call stays with the agent', { error: String(error) });
    }
  }

  // ---- reconnect -----------------------------------------------------------

  private scheduleReconnect(): void {
    const policy = this.deps.options.reconnect;
    this.reconnectAttempt++;
    if (this.reconnectAttempt > policy.maxAttempts) {
      this.fail(new Error(`provider reconnect exhausted after ${policy.maxAttempts} attempts`), 'provider-failed');
      return;
    }
    this.reconnecting = true;
    const delayMs = delayForAttempt(policy, this.reconnectAttempt);
    this.emit('provider.reconnecting', { attempt: this.reconnectAttempt, delayMs });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.reconnectProvider();
    }, delayMs);
    this.timers.add(timer);
  }

  private async reconnectProvider(): Promise<void> {
    if (this.stateValue !== 'active') return;
    const provider = this.provider;
    if (!provider) return;
    try {
      await provider.connect(this.buildProviderInit());
    } catch (error) {
      this.log.warn('reconnect attempt failed', { attempt: this.reconnectAttempt, error: String(error) });
      this.scheduleReconnect();
      return;
    }
    if (this.stateValue !== 'active') return;
    this.reconnectAttempt = 0;
    this.reconnecting = false;
    // Session resumption restored context server-side, and a provider that
    // seeds `init.history` at connect already has it — re-injecting the
    // transcript would duplicate it.
    if (!provider.didResume && !provider.capabilities.startupHistory) this.reinjectHistory(provider);
    this.flushInboundBuffer();
    this.emit('provider.reconnected');
  }

  /** After a reconnect the provider session is blank — restore conversational context. */
  private reinjectHistory(provider: BaseRealtimeProvider): void {
    if (this.transcriptEntries.length === 0) return;
    const summary = formatTranscriptForInjection(this.transcriptEntries, {
      agentNames: new Map([...this.agents].map(([id, agent]) => [id, agent.name])),
      handoffs: this.handoffHistory,
    });
    provider.sendText(
      `Context: this phone call reconnected mid-conversation. You are ${this.activeAgentValue.name}. ` +
        `Each line below names who said it; \`[transfer]\` lines are routing that ALREADY happened.\n` +
        `${summary}\n` +
        `Anything already answered or already routed above must not be routed again. ` +
        `Continue naturally from where it left off; do not greet again.`,
      { role: 'system', triggerResponse: false },
    );
  }

  // ---- handoff -------------------------------------------------------------

  /**
   * Refuse a model-initiated transfer from an agent the caller has not spoken
   * to yet. The refusal must reach the model as the tool result, or it simply
   * calls the same transfer tool again on its next turn.
   */
  private rejectHandoff(target: Agent, reason: string | undefined, callId: string): void {
    const from = this.activeAgentValue;
    this.log.warn(
      `blocked transfer ${from.id} -> ${target.id}: the caller has not spoken since the last one`,
    );
    this.deliverToolResult(callId, {
      error: 'transfer_rejected',
      message:
        'You just took over this call and the caller has not spoken since. Do not transfer again ' +
        'yet — handle their request yourself, or ask them what they need. You may transfer once ' +
        'they reply.',
    });
    this.emit('agent.handoff.blocked', { from, to: target, reason, cause: 'no-caller-turn' });
  }

  private async performHandoff(target: Agent, reason?: string): Promise<void> {
    if (this.stateValue !== 'active' || !this.provider) return;
    if (target.id === this.activeAgentValue.id) return;
    const from = this.activeAgentValue;
    this.activeAgentValue = target;
    // The incoming agent must hear the caller before it may transfer on.
    this.handoffLockedUntilCallerTurn = true;
    this.toolset = this.buildToolset();
    this.handoffHistory.push({
      from: from.id,
      to: target.id,
      atMs: Date.now() - this.startedAtMs,
      ...(reason ? { reason } : {}),
    });

    const continueInstruction =
      `You are now ${target.name}. Continue the SAME phone conversation naturally — ` +
      `acknowledge the caller and take over; do not restart with a cold greeting.` +
      (reason ? ` Transfer context: ${reason}.` : '');

    const voiceChanges = target.voice !== undefined && target.voice !== from.voice;
    const mustReconnect =
      !this.provider.capabilities.sessionUpdate ||
      (voiceChanges &&
        !this.provider.capabilities.voiceChangeMidSession &&
        this.deps.options.handoffVoicePolicy === 'reconnect');

    if (!mustReconnect) {
      if (voiceChanges && !this.provider.capabilities.voiceChangeMidSession) {
        this.log.warn(
          `agent "${target.id}" declares voice "${target.voice}" but the provider cannot change voice mid-session — keeping the current voice (set handoffVoicePolicy: 'reconnect' to switch)`,
        );
      }
      await this.provider.updateSession({
        instructions: this.composeInstructions(),
        tools: this.buildProviderInit().tools,
        providerOptions: target.providerOptions,
      });
      this.provider.createResponse({ instructions: continueInstruction });
    } else {
      // Close-and-reopen with the new agent's config, carrying context over.
      this.handoffInProgress = true;
      this.reconnecting = true; // buffer caller audio during the gap
      const hold = this.deps.options.handoffHold;
      if (hold) {
        this.bgAudio.acquire('__handoff__', hold.spec, { ...hold, startDelayMs: hold.startDelayMs ?? 300 });
      }
      try {
        await this.provider.close();
        await this.provider.connect({ ...this.buildProviderInit(), freshSession: true });
        if (!this.provider.capabilities.startupHistory) this.reinjectHistory(this.provider);
        this.provider.createResponse({ instructions: continueInstruction });
      } catch (error) {
        this.handoffInProgress = false;
        this.reconnecting = false;
        this.fail(
          error instanceof Error ? error : new Error(String(error)),
          'provider-failed',
        );
        return;
      } finally {
        this.bgAudio.release('__handoff__', { immediate: false });
      }
      this.handoffInProgress = false;
      this.reconnecting = false;
      this.flushInboundBuffer();
    }

    this.emit('agent.handoff', { from, to: target, reason });
    void this.saveSnapshot();
  }

  // ---- pre-synthesized greeting --------------------------------------------

  /**
   * Burst-write a stored μ-law greeting straight onto the Twilio socket —
   * no pacing loop (Twilio buffers and plays at line rate), so playback
   * starts immediately while the provider session is still being built.
   */
  private playPreGreeting(): void {
    const preSynthesized = this.deps.options.greeting.preSynthesized;
    if (!preSynthesized || !this.deps.transport.isOpen) return;
    let audio: Buffer;
    try {
      audio = Buffer.isBuffer(preSynthesized.audio)
        ? preSynthesized.audio
        : readFileSync(preSynthesized.audio);
    } catch (error) {
      this.log.warn('pre-synthesized greeting unavailable — falling back to model greeting', {
        error: String(error),
      });
      return;
    }
    if (audio.length === 0) return;
    const durationMs = mulawBytesToMs(audio.length);
    this.pregreeting = { text: preSynthesized.text, durationMs, played: false };

    for (let offset = 0; offset < audio.length; offset += PREGREETING_CHUNK_BYTES) {
      const chunk = audio.subarray(offset, Math.min(offset + PREGREETING_CHUNK_BYTES, audio.length));
      this.deps.transport.sendMedia(chunk.toString('base64'));
    }
    this.deps.transport.sendMark(PREGREETING_MARK);

    const entry: TranscriptEntry = {
      role: 'agent',
      text: preSynthesized.text,
      timestampMs: 0,
      agentId: this.activeAgentValue.id,
    };
    this.transcriptEntries.push(entry);
    this.emit('transcript.agent', entry);
  }

  // ---- keypad (DTMF) input -------------------------------------------------

  private handleKeypress(key: string): void {
    if (!this.keypadCollector) return;
    // Typing means "stop talking, I'm answering". interrupt() no-ops when the
    // agent is silent; without it a flushed entry would queue its readback
    // behind whatever stale speech is still playing out.
    if (this.deps.options.keypad?.interruptOnKeypress !== false) this.interrupt();
    this.keypadCollector.press(key);
  }

  private onKeypadEntry(entry: KeypadEntry): void {
    // A completed entry is a caller turn (it is injected as one below), so it
    // releases an agent that took over and has not heard the caller yet.
    this.handoffLockedUntilCallerTurn = false;
    this.emit('keypad.entry', entry);
    const message = this.deps.options.keypad?.message;
    if (message === false) return;
    // Role 'user', not 'system': the response this triggers must answer the
    // entry itself — a trailing system item is skipped by the response it
    // triggers and only lands one response later (field-tested on xAI).
    this.provider?.sendText((message ?? defaultKeypadMessage)(entry), {
      role: 'user',
      triggerResponse: true,
    });
  }

  private onKeypadCleared(info: { discarded: string }): void {
    this.emit('keypad.cleared', info);
    const clearMessage = this.deps.options.keypad?.clearMessage;
    if (clearMessage === false) return;
    this.provider?.sendText(clearMessage ?? DEFAULT_KEYPAD_CLEAR_MESSAGE, {
      role: 'user',
      triggerResponse: true,
    });
  }

  // ---- idle nudges ---------------------------------------------------------

  /** Armed whenever the agent goes quiet and we're waiting on the caller. */
  private armIdleTimer(): void {
    const idle = this.deps.options.idle;
    if (!idle || this.stateValue !== 'active' || this.pendingHangup) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.onIdleTimeout();
    }, idle.timeoutSeconds * 1000);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private onIdleTimeout(): void {
    const idle = this.deps.options.idle;
    if (!idle || this.stateValue !== 'active' || !this.provider?.isConnected) return;
    if (this.generating || this.tracker.isPlaybackActive() || this.runningTools.size > 0) {
      this.armIdleTimer();
      return;
    }
    const prompts = idle.prompts?.length
      ? idle.prompts
      : ['The caller has gone quiet. Gently check if they are still there.'];
    const maxNudges = idle.maxNudges ?? prompts.length;
    if (this.nudgeCount < maxNudges) {
      const prompt = prompts[Math.min(this.nudgeCount, prompts.length - 1)]!;
      this.nudgeCount++;
      this.provider.createResponse({ instructions: prompt });
      // Re-armed by that nudge's playback.finished.
      return;
    }
    this.log.info('caller idle beyond nudges — ending call');
    this.hangupReason = 'idle-timeout';
    this.provider.createResponse({
      instructions:
        idle.goodbye ??
        'You could not hear the caller anymore. Say a brief goodbye and that they are welcome to call back, then stop speaking.',
    });
    void this.armHangup();
  }

  // ---- watchdogs -----------------------------------------------------------

  private startMaxDurationWatchdog(): void {
    const seconds = this.deps.options.maxCallDurationSeconds;
    if (!seconds) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.log.info('max call duration reached');
      void this.teardown('max-duration');
    }, seconds * 1000);
    timer.unref?.();
    this.timers.add(timer);
  }

  // ---- teardown ------------------------------------------------------------

  private fail(error: Error, reason: CallEndReason): void {
    this.emit('call.failed', error);
    void this.teardown(reason);
  }

  private async teardown(reason: CallEndReason): Promise<void> {
    if (this.stateValue === 'ended') return;
    this.stateValue = 'ended';
    this.endedReason = reason;

    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.clearIdleTimer();
    this.keypadCollector?.dispose();
    this.bgAudio.stop({ immediate: true });
    for (const controller of this.runningTools.values()) {
      controller.abort(new Error('call ended'));
    }
    this.runningTools.clear();
    for (const approval of this.approvals.values()) clearTimeout(approval.timer);
    this.approvals.clear();
    this.deferredPending.clear();
    this.pendingInjections = [];
    this.toolQueue.clear();
    this.inboundBuffer = [];

    const pending = this.pendingHangup;
    this.pendingHangup = null;
    if (pending) {
      clearTimeout(pending.watchdog);
      pending.resolvers.forEach((resolve) => resolve());
    }

    const provider = this.provider;
    this.provider = null;
    if (provider) provider.removeAllListeners();
    this.deps.transport.close();

    // Emit before the async socket close: listeners see the end synchronously
    // with the state flip, not after network teardown latency.
    const durationMs = Date.now() - this.startedAtMs;
    this.emit('call.ended', { reason, durationMs, usage: this.usage });

    if (provider) await provider.close().catch(() => {});
    await this.saveSnapshot();
    this.deps.onEnded?.(this.callSid, reason);
  }

  private async saveSnapshot(): Promise<void> {
    const snapshot: CallSnapshot = {
      callSid: this.callSid,
      streamSid: this.streamSid,
      state: this.stateValue,
      activeAgentId: this.activeAgentValue.id,
      transcript: [...this.transcriptEntries],
      usage: this.usage,
      context: this.context.toJSON(),
      handoffHistory: [...this.handoffHistory],
      startedAtMs: this.startedAtMs,
      ...(this.stateValue === 'ended'
        ? { endedAtMs: Date.now(), endReason: this.endedReason ?? undefined }
        : {}),
    };
    try {
      await this.deps.store.save(snapshot);
    } catch (error) {
      this.log.warn('session store save failed', { error: String(error) });
    }
  }
}

const PREGREETING_MARK = 'pre:greeting';
/** Longer than the speech gate's quiet window plus the mark round trip (0.8 s + ~0.3 s). */
const HANGUP_SENTENCE_GRACE_MS = 1500;
/** 400ms per frame — matches production burst-write implementations. */
const PREGREETING_CHUNK_BYTES = 3200;

type ToolOutcome = { ok: true; result: unknown } | { ok: false; payload: unknown; message: string };

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Base64 μ-law digital silence with the same byte length as `payload`. */
function silenceLike(payload: string): string {
  const bytes = base64ByteLength(payload);
  if (bytes === SILENCE_FRAME_BYTES) return SILENCE_FRAME_BASE64;
  return Buffer.alloc(Math.max(0, Math.round(bytes)), MULAW_SILENCE_BYTE).toString('base64');
}
const SILENCE_FRAME_BYTES = 160;
const SILENCE_FRAME_BASE64 = Buffer.alloc(SILENCE_FRAME_BYTES, MULAW_SILENCE_BYTE).toString('base64');

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}
