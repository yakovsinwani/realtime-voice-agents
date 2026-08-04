import type { BackgroundAudioSpec } from '../audio/background/presets.js';
import type { ToolContext } from './context.js';
import { zodToJsonSchema } from './json-schema.js';

/** Structural Zod schema shape — works with both Zod 3 and Zod 4. */
export interface ZodSchemaLike {
  safeParse(data: unknown):
    | { success: true; data: any }
    | { success: false; error: { message?: string; issues?: unknown[] } };
}

type IsAny<T> = 0 extends 1 & T ? true : false;

/** Output type of a Zod schema, for either Zod major. */
export type InferSchema<S> =
  IsAny<S> extends true
    ? any
    : S extends { _zod: { output: infer O } }
      ? O
      : S extends { _output: infer O }
        ? O
        : unknown;

/**
 * How a tool call is executed relative to the conversation:
 * - `sync` — the model waits for the result before speaking (default)
 * - `dispatch` — fire-and-forget: the model immediately gets `{status:'queued'}`
 *   and keeps talking; the work runs detached
 * - `deferred` — the model gets `{status:'pending'}` and keeps talking; the
 *   real result is injected as a new turn when it arrives
 * - `humanInTheLoop` — execution pauses for `session.approveTool()` /
 *   `rejectTool()`; an approval event fires for your backend
 */
export type ToolStrategy = 'sync' | 'dispatch' | 'deferred' | 'humanInTheLoop';

export interface ToolDefinition<S extends ZodSchemaLike = ZodSchemaLike, Out = unknown> {
  /** Function name shown to the model: [a-zA-Z0-9_-], ≤64 chars. */
  name: string;
  description: string;
  parameters: S;
  execute: (input: InferSchema<S>, ctx: ToolContext) => Out | Promise<Out>;
  strategy?: ToolStrategy;
  /** Abort execute() and return a timeout error to the model. Default 15000. */
  timeoutMs?: number;
  /** Hold audio while the tool runs. `false` disables even bridge defaults. */
  backgroundAudio?: BackgroundAudioSpec | false;
  /** For `humanInTheLoop`: auto-reject if not approved in time. Default 30000. */
  approvalTimeoutMs?: number;
  /** May veto (throw) or replace the input. */
  onBeforeExecute?: (input: InferSchema<S>, ctx: ToolContext) => void | InferSchema<S> | Promise<void | InferSchema<S>>;
  /** May observe or replace the result sent to the model. */
  onAfterExecute?: (result: Out, ctx: ToolContext) => void | unknown | Promise<void | unknown>;
  /** May map an error to a model-visible payload (instead of a generic one). */
  onError?: (error: unknown, ctx: ToolContext) => void | unknown | Promise<void | unknown>;
}

export interface Tool<S extends ZodSchemaLike = any, Out = any>
  extends ToolDefinition<S, Out> {
  strategy: ToolStrategy;
  /** JSON Schema for the provider tool declaration (computed once). */
  readonly parametersJsonSchema: Record<string, unknown>;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Define a provider-agnostic tool with a Zod parameters schema. */
export function tool<S extends ZodSchemaLike, Out>(
  definition: ToolDefinition<S, Out>,
): Tool<S, Out> {
  if (!NAME_PATTERN.test(definition.name)) {
    throw new Error(
      `tool name "${definition.name}" is invalid (allowed: letters, digits, _ and -, max 64 chars)`,
    );
  }
  return {
    ...definition,
    strategy: definition.strategy ?? 'sync',
    parametersJsonSchema: zodToJsonSchema(definition.parameters),
  };
}
