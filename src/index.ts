/**
 * realtime-voice-agents — provider-agnostic bridge between Twilio Media
 * Streams and realtime speech-to-speech AI APIs.
 *
 * Core entry point: bridge, session, Agent, tool(), events, and shared types.
 * Provider factories live in the subpath exports: `realtime-voice-agents/openai`,
 * `/xai`, `/gemini`. Twilio helpers in `/twilio`, audio primitives in `/audio`,
 * session stores in `/store`, and test fakes in `/testing`.
 */

// Bridge + session
export { TwilioRealtimeBridge } from './bridge/TwilioRealtimeBridge.js';
export { CallSession } from './bridge/CallSession.js';
export {
  type BridgeConfig,
  type BuiltinToolsConfig,
  type SessionOptions,
  type GreetingOptions,
  type DeafnessOptions,
  type IdleOptions,
  type HangupOptions,
  type TwilioRestOptions,
  DEFAULT_SESSION_OPTIONS,
  resolveSessionOptions,
} from './bridge/config.js';
export type { CallState, CallEndReason } from './bridge/state.js';
export type {
  SessionEventMap,
  BridgeEventMap,
  CallStartedInfo,
  ToolRunInfo,
  ApprovalRequestInfo,
  VadSuggestionInfo,
  ProviderFallbackInfo,
} from './bridge/events.js';

// Agents
export { Agent, collectAgentGraph, type AgentDefinition } from './agents/Agent.js';
export {
  createHandoffTool,
  handoffToolName,
  isHandoffDirective,
  type HandoffDirective,
} from './agents/handoff.js';

// Pre-synthesized greeting capture
export {
  captureGreetingAudio,
  type CaptureGreetingOptions,
  type CapturedGreeting,
} from './greeting/capture.js';

// Tools
export {
  tool,
  type Tool,
  type ToolDefinition,
  type ToolStrategy,
  type ZodSchemaLike,
  type InferSchema,
} from './tools/tool.js';
export {
  SessionContext,
  type ToolContext,
  type CallSessionFacade,
  type ToolCallInfo,
} from './tools/context.js';
export { zodToJsonSchema } from './tools/json-schema.js';
export {
  decorateTool,
  composeExecution,
  type ToolMiddleware,
  type ToolDecoration,
} from './tools/middleware.js';
export { createFinishCallTool, type FinishCallToolOptions } from './tools/builtins/finishCall.js';
export { createTransferCallTool, type TransferCallToolOptions } from './tools/builtins/transferCall.js';

// Provider abstraction (implementations live in subpath exports)
export {
  BaseRealtimeProvider,
  type ProviderFactory,
  type ProviderFactoryContext,
  type ProviderSessionInit,
  type ProviderToolSchema,
  type SendTextOptions,
  type SendToolResultOptions,
  type SessionUpdateOptions,
  type VadConfig,
} from './providers/base/BaseRealtimeProvider.js';
export type { ProviderCapabilities, VadTuningProfile } from './providers/base/capabilities.js';
export type {
  ProviderEvents,
  ProviderAudioDelta,
  ProviderToolCall,
  ProviderCloseInfo,
  ProviderUsage,
} from './providers/base/events.js';
export {
  DEFAULT_RECONNECT_POLICY,
  type ReconnectPolicy,
} from './providers/base/reconnect.js';

// Interruption
export {
  InterruptionController,
  type InterruptionSettings,
  type InterruptionRateLimit,
  type InterruptionDecision,
  type InterruptionBlockCause,
} from './interruption/InterruptionController.js';

// Keypad (DTMF) input
export {
  KeypadCollector,
  DEFAULT_KEYPAD_OPTIONS,
  DEFAULT_KEYPAD_INSTRUCTIONS,
  DEFAULT_KEYPAD_CLEAR_MESSAGE,
  defaultKeypadMessage,
  type KeypadOptions,
  type KeypadEntry,
  type KeypadEntryReason,
  type KeypadHandle,
  type KeypadKeyKind,
  type KeypadCollectorHooks,
} from './dtmf/KeypadCollector.js';

// Noise-adaptive VAD
export {
  NoiseAdaptiveVadController,
  type NoiseAdaptiveVadOptions,
  type VadAdjustment,
  type VadNoiseMetrics,
} from './vad/NoiseAdaptiveVadController.js';

// Playback
export { PlaybackTracker, type MarkEchoResult } from './playback/PlaybackTracker.js';

// Session state
export type { TranscriptEntry } from './session/transcript.js';
export { type UsageInfo, emptyUsage } from './session/usage.js';
export type { CallSnapshot } from './session/snapshot.js';
export type { SessionStore } from './session/SessionStore.js';
export { InMemorySessionStore } from './session/InMemorySessionStore.js';

// Background audio types (engine in /audio)
export type {
  BackgroundAudioPreset,
  BackgroundAudioSpec,
  BackgroundAudioOptions,
} from './audio/background/presets.js';

// Logging
export { type Logger, noopLogger, consoleLogger } from './logging/logger.js';

// Twilio essentials re-exported for convenience (full set in /twilio)
export { connectStreamTwiml } from './twilio/twiml.js';
export type { WebSocketLike } from './twilio/transport.js';
export type { TwilioStartEvent } from './twilio/messages.js';
