/**
 * `session.start` construction for GPT-Live (`/v1/live/sessions`).
 *
 * The session object is a STRICT schema: an unknown field rejects the whole
 * start with `unknown_parameter` (field-verified Sept 2026), so every key
 * here is a documented one and `providerOptions` / `extraSessionOptions`
 * are deep-merged last as a deliberate escape hatch. Wire facts baked in:
 * - one audio format for both directions, `{ type: 'audio/pcmu', rate: 8000 }`
 *   (Twilio's wire format — no transcoding)
 * - instructions, voice, format and history are immutable after start
 * - tools do not live on the voice model: they are `delegation.responses.tools`
 *   for the backend Responses model that reasons and calls them
 * - history is `input`: ≤ 128 text messages / ≤ 8,192 rendered tokens
 */

import { deepMerge } from '../../internal/merge.js';
import type {
  ProviderHistoryEntry,
  ProviderSessionInit,
  ProviderToolSchema,
} from '../base/BaseRealtimeProvider.js';

export interface GptLiveDelegationOptions {
  /** Backend Responses model that reasons and calls tools. Default `gpt-5.6-terra`. */
  model?: string;
  /**
   * Backend prompt — procedures, tool rules, verification. The Agent's
   * `instructions` stay the VOICE prompt (style, interruption policy, when to
   * delegate); GPT-Live is prompted in two halves.
   */
  instructions?: string;
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string };
  parallelToolCalls?: boolean;
  maxOutputTokens?: number;
  reasoning?: { effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; summary?: string };
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
  text?: { verbosity?: 'low' | 'medium' | 'high' };
  /** Extra provider-native backend tools, e.g. `{ type: 'web_search' }`. */
  extraTools?: Array<Record<string, unknown>>;
}

export interface GptLiveSessionConfig {
  defaultVoice?: string;
  delegation?: GptLiveDelegationOptions;
  /** Store the session server-side (30 days) for recording download / forking. */
  store?: boolean;
  /** Provider-native session fields, deep-merged last. Strict schema — see above. */
  extraSessionOptions?: Record<string, unknown>;
  /** History trimming: newest turns kept within these bounds (API: 128 messages / 8,192 tokens). */
  historyMaxMessages?: number;
  historyMaxChars?: number;
}

export const GPT_LIVE_DEFAULT_BACKEND_MODEL = 'gpt-5.6-terra';
export const GPT_LIVE_AUDIO_FORMAT = { type: 'audio/pcmu', rate: 8000 } as const;
const HISTORY_MAX_MESSAGES = 128;
/** ≈ 8,192 tokens at a conservative 2.5 chars/token (Hebrew and other dense scripts). */
const HISTORY_MAX_CHARS = 20_000;

export function toBackendTool(tool: ProviderToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters,
  };
}

export function buildDelegation(
  tools: readonly ProviderToolSchema[] | undefined,
  options: GptLiveDelegationOptions = {},
): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    model: options.model ?? GPT_LIVE_DEFAULT_BACKEND_MODEL,
    tools: [...(tools ?? []).map(toBackendTool), ...(options.extraTools ?? [])],
    tool_choice: options.toolChoice ?? 'auto',
  };
  if (options.instructions !== undefined) responses.instructions = options.instructions;
  if (options.parallelToolCalls !== undefined) responses.parallel_tool_calls = options.parallelToolCalls;
  if (options.maxOutputTokens !== undefined) responses.max_output_tokens = options.maxOutputTokens;
  if (options.reasoning !== undefined) responses.reasoning = options.reasoning;
  if (options.serviceTier !== undefined) responses.service_tier = options.serviceTier;
  if (options.text !== undefined) responses.text = options.text;
  return { type: 'responses', responses };
}

/**
 * History → `input` items, newest-first trimming to the API bounds. A leading
 * `developer` entry (the engine's continuation note) is pinned so trimming
 * never drops the context that explains the rest.
 */
export function buildHistoryItems(
  history: readonly ProviderHistoryEntry[] | undefined,
  limits: { maxMessages?: number; maxChars?: number } = {},
): { items: Array<Record<string, unknown>>; dropped: number } {
  if (!history || history.length === 0) return { items: [], dropped: 0 };
  const maxMessages = limits.maxMessages ?? HISTORY_MAX_MESSAGES;
  const maxChars = limits.maxChars ?? HISTORY_MAX_CHARS;
  const pinned = history[0]!.role === 'developer' ? [history[0]!] : [];
  const rest = history.slice(pinned.length);
  let chars = pinned.reduce((n, e) => n + e.text.length, 0);
  const kept: ProviderHistoryEntry[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const entry = rest[i]!;
    if (kept.length + pinned.length >= maxMessages) break;
    if (chars + entry.text.length > maxChars) break;
    chars += entry.text.length;
    kept.unshift(entry);
  }
  const items = [...pinned, ...kept].map((entry) => ({
    type: 'message',
    role: entry.role,
    content: [{ type: entry.role === 'assistant' ? 'output_text' : 'input_text', text: entry.text }],
  }));
  return { items, dropped: rest.length - kept.length };
}

export function buildSessionStart(
  init: ProviderSessionInit,
  config: GptLiveSessionConfig,
  eventId: string,
  model: string,
): { frame: Record<string, unknown>; droppedHistory: number } {
  const { items, dropped } = buildHistoryItems(init.history, {
    maxMessages: config.historyMaxMessages,
    maxChars: config.historyMaxChars,
  });
  const voice = init.voice ?? config.defaultVoice;
  let session: Record<string, unknown> = {
    model,
    instructions: init.instructions,
    audio: {
      format: { ...GPT_LIVE_AUDIO_FORMAT },
      ...(voice ? { output: { voice } } : {}),
    },
    delegation: buildDelegation(init.tools, config.delegation),
    ...(items.length ? { input: items } : {}),
    ...(config.store ? { store: true } : {}),
  };
  session = deepMerge(session, init.providerOptions);
  session = deepMerge(session, config.extraSessionOptions);
  return { frame: { type: 'session.start', event_id: eventId, session }, droppedHistory: dropped };
}
