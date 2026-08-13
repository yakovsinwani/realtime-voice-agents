/**
 * Gemini Live provider via the official `@google/genai` SDK (optional peer).
 *
 * Unlike the OpenAI-compatible path, Gemini speaks PCM (16 kHz in, 24 kHz
 * out), so this provider owns a stateful transcoding pair: μ-law↔PCM with
 * inter-chunk resampler state — the engine stays μ-law-only.
 *
 * Gemini specifics handled here:
 * - turn ids are synthesized (`gturn_N`) — the wire has no response ids
 * - `serverContent.interrupted` is the barge-in signal (maps to
 *   userSpeechStarted + responseDone; the server already cancelled itself)
 * - session resumption handles are captured continuously and replayed on the
 *   next connect, so reconnects restore context server-side
 * - `goAway` (imminent disconnect, e.g. the session time limit) is surfaced
 *   so the session can reconnect proactively
 * - tool results go through the proper `toolResponse` message
 */

import { InboundTranscoder, OutboundTranscoder } from '../../audio/transcode.js';
import { deepMerge } from '../../internal/merge.js';
import type { Logger } from '../../logging/logger.js';
import { noopLogger } from '../../logging/logger.js';
import {
  BaseRealtimeProvider,
  type ProviderSessionInit,
  type SendTextOptions,
  type SendToolResultOptions,
  type VadConfig,
} from '../base/BaseRealtimeProvider.js';
import type { ProviderCapabilities } from '../base/capabilities.js';

/** Structural slice of @google/genai's live session (also what fakes implement). */
export interface GeminiLiveSessionLike {
  sendRealtimeInput(input: { audio: { data: string; mimeType: string } }): void;
  sendClientContent(content: { turns: Array<Record<string, unknown>>; turnComplete?: boolean }): void;
  sendToolResponse(response: { functionResponses: Array<Record<string, unknown>> }): void;
  close(): void;
}

export interface GeminiConnectParams {
  model: string;
  config: Record<string, unknown>;
  callbacks: {
    onopen?: () => void;
    onmessage: (message: any) => void;
    onerror?: (error: any) => void;
    onclose?: (event: { code?: number; reason?: string }) => void;
  };
}

export type GeminiLiveConnector = (params: GeminiConnectParams) => Promise<GeminiLiveSessionLike>;

export interface GeminiLiveProviderConfig {
  /** API-key auth (Google AI Studio). Ignored when `vertex` is set. */
  apiKey?: string;
  /** Vertex AI auth (uses Application Default Credentials). */
  vertex?: { project: string; location: string };
  model: string;
  voice?: string;
  languageCode?: string;
  defaultVad?: VadConfig | null;
  /** Input/output transcription toggles. Default both on. */
  transcription?: { input?: boolean; output?: boolean } | false;
  /** Use session resumption handles across reconnects. Default true. */
  resumption?: boolean;
  /** Ask Gemini to compress old context instead of dying at the token limit. */
  contextWindowCompression?: boolean;
  /** Provider-native `config` fields, deep-merged last (escape hatch). */
  extraConfig?: Record<string, unknown>;
  connectTimeoutMs?: number;
  /** Test seam: replaces `new GoogleGenAI(...).live.connect`. */
  connector?: GeminiLiveConnector;
}

const GEMINI_INPUT_MIME = 'audio/pcm;rate=16000';

export class GeminiLiveProvider extends BaseRealtimeProvider {
  readonly name = 'gemini';
  readonly capabilities: ProviderCapabilities = {
    truncate: false,
    sessionUpdate: false,
    voiceChangeMidSession: false,
    transcodeRequired: true,
    resumption: true,
    agentTranscriptDeltas: true,
    // Gemini Live's activity handling always interrupts server-side; the
    // interruption guard falls back to protecting buffered audio only.
    vadInterruptControl: false,
  };

  private readonly config: GeminiLiveProviderConfig;
  private readonly logger: Logger;
  private session: GeminiLiveSessionLike | null = null;
  private sessionInit: ProviderSessionInit | null = null;
  private ready = false;
  private intentionalClose = false;

  private readonly inbound = new InboundTranscoder(16000);
  private readonly outbound = new OutboundTranscoder(24000);

  private turnCounter = 0;
  private currentTurnId: string | null = null;
  private userTranscriptBuffer = '';
  private agentTranscriptBuffer = '';
  private resumptionHandle: string | null = null;
  private resumed = false;

  constructor(config: GeminiLiveProviderConfig, logger: Logger = noopLogger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  get isConnected(): boolean {
    return this.ready && this.session !== null;
  }

  /** True when the last connect restored server-side context via a handle. */
  override get didResume(): boolean {
    return this.resumed;
  }

  async connect(init: ProviderSessionInit): Promise<void> {
    if (this.session) await this.close();
    this.sessionInit = init;
    this.intentionalClose = false;
    this.ready = false;
    this.resumed = false;
    this.inbound.reset();
    this.outbound.reset();

    const connector = this.config.connector ?? (await this.defaultConnector());
    const handle = init.freshSession
      ? undefined
      : (init.resumptionHandle ?? this.resumptionHandle ?? undefined);
    if (init.freshSession) this.resumptionHandle = null;

    let setupResolve!: () => void;
    let rejectSetup!: (error: Error) => void;
    const setupDone = new Promise<void>((resolve, reject) => {
      setupResolve = resolve;
      rejectSetup = reject;
    });
    // A setup failure produces TWO rejections — the SDK's connect promise and
    // setupDone (via onclose/onerror). Only one is awaited below; observe
    // setupDone unconditionally so the losing rejection can never escape as a
    // process-killing unhandledRejection, and keep the first setup error so
    // the connector path can surface the server's close reason instead of the
    // SDK's generic failure.
    let setupError: Error | null = null;
    setupDone.catch(() => {});
    const setupReject = (error: Error) => {
      setupError ??= error;
      rejectSetup(error);
    };
    const timeoutMs = this.config.connectTimeoutMs ?? 10_000;
    const timer = setTimeout(
      () => setupReject(new Error(`gemini setup not complete within ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();

    try {
      try {
        this.session = await connector({
          model: this.config.model,
          config: this.buildConfig(init, handle),
          callbacks: {
            onopen: () => this.emit('open'),
            onmessage: (message) => {
              if (message?.setupComplete !== undefined) {
                this.ready = true;
                if (handle) this.resumed = true;
                setupResolve();
                return;
              }
              this.handleMessage(message);
            },
            onerror: (error) => {
              const err = error instanceof Error ? error : new Error(String(error?.message ?? error));
              if (!this.ready) setupReject(err);
              else this.emit('error', err);
            },
            onclose: (event) => {
              const wasReady = this.ready;
              this.ready = false;
              this.session = null;
              if (!wasReady) {
                setupReject(new Error(`gemini closed during setup (${event?.code} ${event?.reason ?? ''})`));
                return;
              }
              this.emit('close', {
                code: event?.code,
                reason: event?.reason,
                retriable: !this.intentionalClose && !isNonRetriableClose(event?.code),
              });
            },
          },
        });
      } catch (error) {
        throw setupError ?? (error instanceof Error ? error : new Error(String(error)));
      }
      await setupDone;
      // Setup complete = the connect-time config (incl. VAD) is live. Gemini
      // has no mid-session updates, so this stays the ACKed truth for the
      // whole connection.
      this.effectiveVadValue = init.vad !== undefined ? init.vad : this.config.defaultVad;
    } finally {
      clearTimeout(timer);
    }
  }

  private async defaultConnector(): Promise<GeminiLiveConnector> {
    let genai: any;
    try {
      genai = await import('@google/genai');
    } catch (error) {
      throw new Error(
        "the '@google/genai' package is required for the Gemini provider — npm install @google/genai",
        { cause: error },
      );
    }
    const { GoogleGenAI } = genai;
    const ai = this.config.vertex
      ? new GoogleGenAI({
          vertexai: true,
          project: this.config.vertex.project,
          location: this.config.vertex.location,
        })
      : new GoogleGenAI({ apiKey: this.config.apiKey });
    return (params: GeminiConnectParams) =>
      ai.live.connect({ model: params.model, config: params.config, callbacks: params.callbacks });
  }

  private buildConfig(init: ProviderSessionInit, resumptionHandle?: string): Record<string, unknown> {
    const transcription = this.config.transcription;
    const vad = init.vad !== undefined ? init.vad : this.config.defaultVad;
    const config: Record<string, unknown> = {
      responseModalities: ['AUDIO'],
      systemInstruction: init.instructions,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: init.voice ?? this.config.voice ?? 'Aoede' },
        },
        ...(this.config.languageCode ? { languageCode: this.config.languageCode } : {}),
      },
      ...(init.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: init.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description ?? '',
                  parameters: tool.parameters,
                })),
              },
            ],
          }
        : {}),
      realtimeInputConfig: { automaticActivityDetection: buildGeminiVad(vad) },
      ...(transcription === false
        ? {}
        : {
            ...(transcription?.input !== false ? { inputAudioTranscription: {} } : {}),
            ...(transcription?.output !== false ? { outputAudioTranscription: {} } : {}),
          }),
      ...(this.config.resumption !== false
        ? { sessionResumption: { ...(resumptionHandle ? { handle: resumptionHandle } : {}) } }
        : {}),
      ...(this.config.contextWindowCompression ? { contextWindowCompression: { slidingWindow: {} } } : {}),
    };
    return deepMerge(deepMerge(config, init.providerOptions), this.config.extraConfig);
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.ready = false;
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      session.close();
    } catch {
      /* already closed */
    }
  }

  sendAudio(base64Mulaw: string): void {
    if (!this.isConnected || !this.session) return;
    const pcm = this.inbound.process(base64Mulaw);
    if (pcm.length === 0) return;
    this.session.sendRealtimeInput({ audio: { data: pcm, mimeType: GEMINI_INPUT_MIME } });
  }

  sendText(text: string, options: SendTextOptions = {}): void {
    if (!this.session) return;
    const role = options.role === 'assistant' ? 'model' : 'user';
    const content = options.role === 'system' ? `(system note) ${text}` : text;
    this.session.sendClientContent({
      turns: [{ role, parts: [{ text: content }] }],
      turnComplete: options.triggerResponse !== false,
    });
  }

  sendToolResult(callId: string, output: unknown, options: SendToolResultOptions = {}): void {
    if (!this.session) return;
    const response =
      output !== null && typeof output === 'object' && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : { result: output };
    this.session.sendToolResponse({
      functionResponses: [{ id: callId, name: this.toolNameForCall(callId), response }],
    });
    // Gemini resumes generation on its own after a tool response; there is no
    // explicit response.create equivalent to suppress.
    void options;
  }

  createResponse(options: { instructions?: string } = {}): void {
    if (!this.session) return;
    const text = options.instructions
      ? `(instruction) ${options.instructions}`
      : '(instruction) Continue the conversation now — speak to the caller.';
    this.session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: true,
    });
  }

  async updateSession(_patch: Partial<ProviderSessionInit>): Promise<void> {
    // Gemini Live has no session.update — config is fixed at connect. The
    // engine's capability flag routes handoffs through reconnect instead.
    this.logger.warn('gemini: updateSession ignored (no mid-session config on Live API)');
  }

  // ---- inbound messages ----------------------------------------------------

  private handleMessage(message: any): void {
    const serverContent = message?.serverContent;

    if (message?.toolCall?.functionCalls) {
      for (const call of message.toolCall.functionCalls) {
        const id = call.id ?? `gcall_${++this.turnCounter}`;
        this.callNames.set(id, call.name);
        this.emit('toolCall', {
          id,
          name: call.name,
          argumentsJson: JSON.stringify(call.args ?? {}),
          responseId: this.currentTurnId ?? undefined,
        });
      }
      return;
    }

    if (message?.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      if (update.resumable && update.newHandle) {
        this.resumptionHandle = update.newHandle;
        this.emit('resumptionUpdate', update.newHandle);
      }
      return;
    }

    if (message?.goAway) {
      const timeLeftMs = parseGoAwayTime(message.goAway.timeLeft);
      this.logger.info('gemini goAway received', { timeLeftMs });
      this.emit('goAway', { timeLeftMs });
      return;
    }

    if (message?.usageMetadata) {
      const usage = message.usageMetadata;
      this.emit('usage', {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.responseTokenCount ?? usage.candidatesTokenCount ?? 0,
        totalTokens: usage.totalTokenCount ?? 0,
        raw: usage,
      });
    }

    if (!serverContent) return;

    if (serverContent.interrupted) {
      // Gemini's VAD detected the caller and already cancelled generation.
      const turnId = this.currentTurnId;
      this.emit('userSpeechStarted');
      if (turnId) {
        this.flushAgentTranscript(turnId);
        this.currentTurnId = null;
        this.emit('responseDone', { responseId: turnId });
      }
      return;
    }

    if (serverContent.inputTranscription?.text) {
      this.userTranscriptBuffer += serverContent.inputTranscription.text;
    }

    if (serverContent.outputTranscription?.text) {
      const turnId = this.ensureTurn();
      this.agentTranscriptBuffer += serverContent.outputTranscription.text;
      this.emit('agentTranscriptDelta', {
        responseId: turnId,
        delta: serverContent.outputTranscription.text,
      });
    }

    const parts = serverContent.modelTurn?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const turnId = this.ensureTurn();
        const mulaw = this.outbound.process(part.inlineData.data);
        if (mulaw.length > 0) {
          this.emit('audio', { base64Mulaw: mulaw, responseId: turnId });
        }
      }
    }

    if (serverContent.turnComplete) {
      this.flushUserTranscript();
      const turnId = this.currentTurnId;
      if (turnId) {
        this.flushAgentTranscript(turnId);
        this.currentTurnId = null;
        this.emit('responseDone', { responseId: turnId });
      }
    }
  }

  private readonly callNames = new Map<string, string>();

  private toolNameForCall(callId: string): string {
    const name = this.callNames.get(callId) ?? callId;
    this.callNames.delete(callId);
    return name;
  }

  private ensureTurn(): string {
    if (!this.currentTurnId) {
      this.currentTurnId = `gturn_${++this.turnCounter}`;
      this.flushUserTranscript();
      this.emit('responseStarted', { responseId: this.currentTurnId });
    }
    return this.currentTurnId;
  }

  private flushUserTranscript(): void {
    const text = this.userTranscriptBuffer.trim();
    this.userTranscriptBuffer = '';
    if (text) this.emit('userTranscript', { text });
  }

  private flushAgentTranscript(turnId: string): void {
    const text = this.agentTranscriptBuffer.trim();
    this.agentTranscriptBuffer = '';
    if (text) this.emit('agentTranscript', { responseId: turnId, text });
  }
}

/** Protocol/auth/policy closes where retrying cannot help. */
function isNonRetriableClose(code?: number): boolean {
  if (code === undefined) return false;
  return code === 1002 || code === 1003 || code === 1007 || code === 1008 || (code >= 4400 && code < 4500);
}

function buildGeminiVad(vad: VadConfig | null | undefined): Record<string, unknown> {
  if (vad === null) return { disabled: true };
  return {
    disabled: false,
    ...(vad?.startSensitivity
      ? { startOfSpeechSensitivity: `START_SENSITIVITY_${vad.startSensitivity.toUpperCase()}` }
      : {}),
    ...(vad?.endSensitivity
      ? { endOfSpeechSensitivity: `END_SENSITIVITY_${vad.endSensitivity.toUpperCase()}` }
      : {}),
    ...(vad?.prefixPaddingMs !== undefined ? { prefixPaddingMs: vad.prefixPaddingMs } : {}),
    ...(vad?.silenceDurationMs !== undefined ? { silenceDurationMs: vad.silenceDurationMs } : {}),
  };
}

function parseGoAwayTime(timeLeft: unknown): number | undefined {
  if (typeof timeLeft === 'number') return timeLeft;
  if (typeof timeLeft === 'string') {
    const seconds = Number.parseFloat(timeLeft.replace(/s$/, ''));
    if (!Number.isNaN(seconds)) return Math.round(seconds * 1000);
  }
  return undefined;
}

