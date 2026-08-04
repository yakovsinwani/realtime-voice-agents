/**
 * CallSession — the per-call orchestrator.
 *
 * One mutable object owns all live state for a call (no split-brain between a
 * store and hot data). The SessionStore only receives immutable snapshots at
 * checkpoints, never reads on the audio path. Teardown is centralized and
 * idempotent: every timer, tool AbortController, provider socket, and Twilio
 * socket is released exactly once.
 */

import { base64ByteLength } from '../audio/mulaw.js';
import { BackgroundAudioPlayer } from '../audio/background/BackgroundAudioPlayer.js';
import type { BackgroundAudioOptions, BackgroundAudioSpec } from '../audio/background/presets.js';
import type { Agent } from '../agents/Agent.js';
import { InterruptionController } from '../interruption/InterruptionController.js';
import { TypedEmitter } from '../internal/events.js';
import { childLogger, type Logger } from '../logging/logger.js';
import { PlaybackTracker } from '../playback/PlaybackTracker.js';
import type {
  BaseRealtimeProvider,
  ProviderFactory,
  ProviderSessionInit,
} from '../providers/base/BaseRealtimeProvider.js';
import { delayForAttempt } from '../providers/base/reconnect.js';
import type { ProviderToolCall } from '../providers/base/events.js';
import type { CallSnapshot } from '../session/snapshot.js';
import type { SessionStore } from '../session/SessionStore.js';
import { formatTranscriptForInjection, type TranscriptEntry } from '../session/transcript.js';
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

export interface CallSessionDeps {
  transport: TwilioMediaTransport;
  start: TwilioStartEvent;
  providerFactory: ProviderFactory;
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

  private stateValue: CallState = 'connecting';
  private readonly deps: CallSessionDeps;
  private readonly log: Logger;
  private readonly tracker = new PlaybackTracker();
  private readonly interruptions: InterruptionController;
  private readonly usageAccumulator = new UsageAccumulator();
  private readonly toolQueue = new ToolResultQueue();
  private readonly transcriptEntries: TranscriptEntry[] = [];
  private readonly toolset: Map<string, Tool>;
  private readonly startedAtMs = Date.now();
  private readonly interruptedResponses = new Set<string>();
  private readonly runningTools = new Map<string, AbortController>();
  private readonly timers = new Set<NodeJS.Timeout>();

  private provider: BaseRealtimeProvider | null = null;
  private activeAgentValue: Agent;
  private generating = false;
  private currentResponseId: string | null = null;
  private firstTurnDone = false;
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

  constructor(deps: CallSessionDeps) {
    super();
    this.deps = deps;
    this.callSid = deps.start.start.callSid;
    this.streamSid = deps.start.start.streamSid ?? deps.start.streamSid;
    this.log = childLogger(deps.logger, { callSid: this.callSid });
    this.activeAgentValue = deps.agent;
    this.context = new SessionContext(deps.options.context);
    this.interruptions = new InterruptionController(deps.options.interruptions);

    const params = deps.start.start.customParameters ?? {};
    this.callInfo = {
      direction: params.direction === 'outbound' ? 'outbound' : 'inbound',
      from: params.from,
      to: params.to,
      customParameters: params,
    };
    this.answered = deps.answeredEarly === true || this.callInfo.direction === 'inbound';
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
    try {
      this.provider = this.deps.providerFactory({ logger: this.log, callSid: this.callSid });
      this.wireProvider(this.provider);
      await this.provider.connect(this.buildProviderInit());
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), 'provider-failed');
      return;
    }
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
    this.flushInboundBuffer();
    this.startMaxDurationWatchdog();
    this.armIdleTimer();
    void this.saveSnapshot();
    this.maybeGreet();
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

  /** Manual barge-in: stop the agent mid-sentence. */
  interrupt(): void {
    if (!this.generating && !this.tracker.isPlaybackActive()) return;
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

  async handoffTo(_agent: Agent | string): Promise<void> {
    throw new Error('multi-agent handoff is not wired yet for this session');
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
    for (const tool of this.activeAgentValue.tools) {
      if (tools.has(tool.name)) {
        this.log.warn(`agent tool "${tool.name}" overrides a builtin of the same name`);
      }
      tools.set(tool.name, tool);
    }
    return tools;
  }

  private buildProviderInit(): ProviderSessionInit {
    return {
      instructions: this.activeAgentValue.resolveInstructions(this.context),
      voice: this.activeAgentValue.voice,
      vad: this.deps.options.vad,
      tools: [...this.toolset.values()].map((tool) => {
        const decorated = decorateTool(tool, this.middlewares);
        return {
          name: tool.name,
          description: decorated.description,
          parameters: decorated.parameters,
        };
      }),
      providerOptions: this.activeAgentValue.providerOptions,
    };
  }

  private wireTransport(): void {
    const { transport } = this.deps;
    transport.on('media', (event) => this.handleInboundMedia(event.media.payload));
    transport.on('mark', (event) => this.handleMarkEcho(event.mark.name));
    transport.on('dtmf', (event) => {
      this.clearIdleTimer();
      this.nudgeCount = 0;
      this.emit('dtmf', { digit: event.dtmf.digit });
    });
    transport.on('stop', () => void this.teardown('caller-hangup'));
    transport.on('close', () => void this.teardown('caller-hangup'));
    transport.on('error', (error) => this.emit('error', error));
  }

  private wireProvider(provider: BaseRealtimeProvider): void {
    provider.on('audio', (delta) => {
      if (this.stateValue !== 'active' && this.stateValue !== 'ending') return;
      if (!this.deps.transport.isOpen) return;
      // Real agent speech preempts any hold loop instantly (no fade, no clear:
      // clearing would flush this very delta out of Twilio's buffer).
      this.bgAudio.notifyAgentAudio();
      this.deps.transport.sendMedia(delta.base64Mulaw);
      const chunkMs = base64ByteLength(delta.base64Mulaw) / 8;
      const markName = this.tracker.onAudioSent(delta.responseId, chunkMs, delta.itemId);
      this.deps.transport.sendMark(markName);
    });

    provider.on('responseStarted', ({ responseId }) => {
      this.generating = true;
      this.currentResponseId = responseId;
      if (this.pendingHangup) this.pendingHangup.sawResponse = true;
      this.clearIdleTimer();
      this.interruptions.onResponseStarted(responseId);
      this.emit('agent.speech.started', { responseId });
    });

    provider.on('responseDone', ({ responseId, usage }) => {
      this.generating = false;
      this.tracker.onGenerationDone(responseId);
      this.emit('agent.speech.ended', { responseId });
      if (usage) {
        const total = this.usageAccumulator.add(usage);
        this.emit('usage.updated', total, usage);
      }
      // A response with no audio produces no marks — settle dependents now.
      if (!this.tracker.isPlaybackActive()) {
        this.flushToolQueue();
        void this.executePendingTransfer();
        this.maybeCompleteHangup();
      }
    });

    provider.on('agentTranscriptDelta', ({ responseId, delta }) => {
      this.interruptions.onAgentTranscriptDelta(responseId, delta);
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
      this.emit('transcript.user', entry);
    });

    provider.on('userSpeechStarted', () => {
      this.clearIdleTimer();
      this.nudgeCount = 0;
      this.emit('user.speech.started');
      this.handleBargeIn();
    });
    provider.on('userSpeechStopped', () => this.emit('user.speech.ended'));

    provider.on('toolCall', (call) => void this.handleToolCall(call));

    provider.on('error', (error) => this.emit('error', error));

    provider.on('close', (info) => {
      if (this.stateValue === 'ended' || this.stateValue === 'ending') return;
      this.emit('provider.closed', { code: info.code, reason: info.reason });
      if (!info.retriable) {
        this.fail(new Error(`provider closed (${info.code} ${info.reason ?? ''})`), 'provider-failed');
        return;
      }
      this.scheduleReconnect();
    });
  }

  // ---- inbound audio -------------------------------------------------------

  private handleInboundMedia(payload: string): void {
    if (this.stateValue === 'ended' || this.stateValue === 'ending') return;
    if (this.deps.options.deafness.ignoreUserAudioUntilFirstTurnDone && !this.firstTurnDone) return;
    if (this.deps.options.deafness.muteDuringToolExecution && this.runningTools.size > 0) return;
    if (this.interruptions.isSuspended) return;

    if (this.provider?.isConnected && !this.reconnecting) {
      this.provider.sendAudio(payload);
    } else {
      this.inboundBuffer.push(payload);
      if (this.inboundBuffer.length > MAX_BUFFERED_INBOUND_FRAMES) this.inboundBuffer.shift();
    }
  }

  private flushInboundBuffer(): void {
    if (!this.provider?.isConnected) return;
    for (const payload of this.inboundBuffer) this.provider.sendAudio(payload);
    this.inboundBuffer = [];
  }

  // ---- playback / marks ----------------------------------------------------

  private handleMarkEcho(name: string): void {
    if (!PlaybackTracker.isTrackedMark(name)) return;
    const result = this.tracker.onMarkEcho(name);
    if (!result || result.kind === 'flushed') return;
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
    this.flushToolQueue();
    void this.executePendingTransfer();
    this.maybeCompleteHangup();
    this.armIdleTimer();
  }

  // ---- interruption --------------------------------------------------------

  private handleBargeIn(): void {
    if (!this.generating && !this.tracker.isPlaybackActive()) return;
    const decision = this.interruptions.evaluate({ toolRunning: this.runningTools.size > 0 });
    if (!decision.allow) {
      this.emit('interruption.blocked', { cause: decision.cause });
      if (decision.instruction) {
        this.provider?.sendText(decision.instruction, { role: 'system', triggerResponse: true });
      }
      return;
    }
    // Server VAD has already cancelled generation; only playback needs killing.
    this.performInterrupt();
  }

  private performInterrupt(): void {
    const active = this.tracker.snapshotActive();
    this.tracker.onClear();
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
    if (this.generating || this.tracker.isPlaybackActive()) {
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
      (this.generating || this.tracker.isPlaybackActive())
    ) {
      this.toolQueue.enqueue({ callId, toolName: '', payload, triggerResponse });
      return;
    }
    this.provider?.sendToolResult(callId, payload, { triggerResponse });
  }

  private flushToolQueue(): void {
    if (this.stateValue === 'ended' || !this.provider?.isConnected) return;
    for (const item of this.toolQueue.drain()) {
      this.provider.sendToolResult(item.callId, item.payload, {
        triggerResponse: item.triggerResponse,
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
    const watchdog = setTimeout(() => {
      this.log.warn('hangup watchdog fired — goodbye playout never confirmed');
      this.completeHangup();
    }, this.deps.options.hangup.markTimeoutMs);
    watchdog.unref?.();
    this.timers.add(watchdog);
    this.pendingHangup = { resolvers: [], watchdog, sawResponse: false };
    return new Promise((resolve) => this.pendingHangup!.resolvers.push(resolve));
  }

  private maybeCompleteHangup(): void {
    if (!this.pendingHangup) return;
    // Wait for the goodbye: a response begun after arming must fully play.
    // Without this, the tool-call response's own done event would race the
    // farewell and hang up mid-flow. The watchdog covers "no goodbye ever".
    if (!this.pendingHangup.sawResponse) return;
    if (this.generating || this.tracker.isPlaybackActive()) return;
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
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
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
    // Session resumption restored context server-side — re-injecting the
    // transcript would duplicate it.
    if (!provider.didResume) this.reinjectHistory(provider);
    this.flushInboundBuffer();
    this.emit('provider.reconnected');
  }

  /** After a reconnect the provider session is blank — restore conversational context. */
  private reinjectHistory(provider: BaseRealtimeProvider): void {
    if (this.transcriptEntries.length === 0) return;
    const summary = formatTranscriptForInjection(this.transcriptEntries);
    provider.sendText(
      `Context: this phone call reconnected mid-conversation. Transcript so far:\n${summary}\nContinue naturally from where it left off; do not greet again.`,
      { role: 'system', triggerResponse: false },
    );
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
      handoffHistory: [],
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

type ToolOutcome = { ok: true; result: unknown } | { ok: false; payload: unknown; message: string };

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}
