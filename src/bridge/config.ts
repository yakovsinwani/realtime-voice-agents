import type { IncomingMessage } from 'node:http';
import type { Agent } from '../agents/Agent.js';
import type { BackgroundAudioOptions, BackgroundAudioSpec } from '../audio/background/presets.js';
import type { InterruptionSettings } from '../interruption/InterruptionController.js';
import type { Logger } from '../logging/logger.js';
import type { ProviderFactory, VadConfig } from '../providers/base/BaseRealtimeProvider.js';
import type { ReconnectPolicy } from '../providers/base/reconnect.js';
import { DEFAULT_RECONNECT_POLICY } from '../providers/base/reconnect.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { TwilioStartEvent } from '../twilio/messages.js';
import { deepMerge } from '../internal/merge.js';

export interface GreetingOptions {
  /**
   * `agent-initiates`: the agent speaks first (silence on answer reads as a
   * dropped call). `user-initiates`: wait for the caller.
   */
  mode: 'agent-initiates' | 'user-initiates';
  /** Extra instructions for the opening response. */
  instructions?: string;
  /**
   * Pre-synthesized greeting: burst-written to the caller while the provider
   * connects (~seconds faster to first word). `audio` is 8 kHz μ-law (raw
   * buffer or file path); `text` is what it says, used to keep the model from
   * greeting twice.
   */
  preSynthesized?: { audio: Buffer | string; text: string };
}

export interface DeafnessOptions {
  /**
   * Drop caller audio until the agent's first turn finishes playing.
   * Useful against noisy pickups talking over the greeting. Default false.
   */
  ignoreUserAudioUntilFirstTurnDone?: boolean;
  /** Drop caller audio while a foreground tool is running. Default true. */
  muteDuringToolExecution?: boolean;
}

export interface IdleOptions {
  /** Seconds of caller silence before the first nudge. */
  timeoutSeconds: number;
  /** Nudge instructions, escalated in order. */
  prompts?: string[];
  /** Nudges before giving up. Default = prompts.length. */
  maxNudges?: number;
  /** Goodbye instruction before hanging up. */
  goodbye?: string;
}

export interface HangupOptions {
  /**
   * Watchdog: if Twilio's final mark echo never arrives (dead socket), force
   * completion after this long. Default 7000.
   */
  markTimeoutMs: number;
}

export interface SessionOptions {
  greeting: GreetingOptions;
  interruptions: InterruptionSettings;
  deafness: DeafnessOptions;
  idle?: IdleOptions;
  maxCallDurationSeconds?: number;
  reconnect: ReconnectPolicy;
  hangup: HangupOptions;
  /** Normalized VAD, mapped to the provider's native config. */
  vad?: VadConfig | null;
  /**
   * `afterPlayback` (default): tool results wait until current agent audio
   * finishes playing. `immediate`: send as soon as the tool completes.
   */
  toolResultDelivery: 'afterPlayback' | 'immediate';
  /** Default hold audio for tools that don't specify their own. */
  toolBackgroundAudio?: { spec: BackgroundAudioSpec } & BackgroundAudioOptions;
  /**
   * When a handoff target declares a different voice on a provider that
   * cannot change voice mid-session: `keep` (default) keeps the current
   * voice; `reconnect` opens a fresh provider session with the new voice and
   * carries context over (adds a beat of latency).
   */
  handoffVoicePolicy?: 'keep' | 'reconnect';
  /** Hold audio covering the reconnect gap on handoffs that need one. */
  handoffHold?: { spec: BackgroundAudioSpec } & BackgroundAudioOptions;
  /** Initial session context KV, available to tools and instructions. */
  context?: Record<string, unknown>;
  /** Handshake bounds for the Twilio start frame. */
  handshake?: { timeoutMs?: number; maxPreStartMessages?: number };
}

export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
  greeting: { mode: 'agent-initiates' },
  interruptions: { enabled: true },
  deafness: { ignoreUserAudioUntilFirstTurnDone: false, muteDuringToolExecution: true },
  reconnect: DEFAULT_RECONNECT_POLICY,
  hangup: { markTimeoutMs: 7000 },
  toolResultDelivery: 'afterPlayback',
};

export function resolveSessionOptions(partial?: Partial<SessionOptions>): SessionOptions {
  return deepMerge(structuredClone(DEFAULT_SESSION_OPTIONS) as any, partial as any);
}

export interface BuiltinToolsConfig {
  /**
   * Let the agent end the call gracefully: it is asked for a closing line,
   * the goodbye's playout is watched via marks, then the leg completes.
   */
  finishCall?: boolean | { description?: string; farewellInstruction?: string };
  /** Let the agent transfer the PSTN leg to a human/number. */
  transferCall?:
    | {
        enabled: true;
        /** Fallback when the model doesn't provide a number. */
        defaultPhoneNumber?: string;
        /** Caller id shown to the transferee. Defaults to bridge twilio.callerId. */
        callerId?: string;
        description?: string;
        /** Spoken before transferring (out-of-band instruction). */
        announcement?: string;
      }
    | false;
  /** Send an SMS via Twilio REST. */
  sendSms?: { enabled: true; from?: string; description?: string } | false;
  /** Send a WhatsApp message via Twilio REST. */
  sendWhatsapp?: { enabled: true; from?: string; description?: string } | false;
}

export interface TwilioRestOptions {
  accountSid: string;
  authToken: string;
  /** Default caller id for transfers. */
  callerId?: string;
}

export interface BridgeConfig {
  /** The (root) agent, or a resolver for multi-tenant routing per call. */
  agent: Agent | ((start: TwilioStartEvent) => Agent | Promise<Agent>);
  provider: ProviderFactory;
  session?:
    | Partial<SessionOptions>
    | ((start: TwilioStartEvent) => Partial<SessionOptions> | Promise<Partial<SessionOptions>>);
  /** Twilio REST credentials — enables clean hangup, transfer, SMS/WhatsApp. */
  twilio?: TwilioRestOptions;
  builtinTools?: BuiltinToolsConfig;
  store?: SessionStore;
  /**
   * Reject unauthorized streams before a session is created. Return false to
   * close with 1008. Typical check: a signed token in customParameters.
   */
  validateConnection?: (
    start: TwilioStartEvent,
    request?: IncomingMessage,
  ) => boolean | Promise<boolean>;
  logger?: Logger;
}
