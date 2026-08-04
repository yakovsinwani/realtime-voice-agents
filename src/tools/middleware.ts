/**
 * Cross-cutting tool middleware — an onion, not before/after hooks.
 *
 * `decorate` mutates what the MODEL sees (description/parameters) at session
 * build; `wrapExecute` nests around execution and may call `next` zero times
 * (short-circuit: human-in-the-loop pauses, canned responses) or once.
 * Middlewares registered first wrap outermost.
 */

import type { ToolContext } from './context.js';
import type { Tool } from './tool.js';

export interface ToolDecoration {
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolMiddleware {
  /** Rewrite the schema/description the model is shown for this tool. */
  decorate?(tool: Tool): ToolDecoration | void;
  /** Wrap execution; call `next()` to proceed inward, or short-circuit. */
  wrapExecute?(
    tool: Tool,
    input: unknown,
    ctx: ToolContext,
    next: () => Promise<unknown>,
  ): Promise<unknown>;
}

/** Apply every middleware's decoration, first-registered first. */
export function decorateTool(
  tool: Tool,
  middlewares: readonly ToolMiddleware[],
): { description: string; parameters: Record<string, unknown> } {
  let description = tool.description;
  let parameters = tool.parametersJsonSchema;
  for (const middleware of middlewares) {
    const decoration = middleware.decorate?.(tool);
    if (decoration?.description !== undefined) description = decoration.description;
    if (decoration?.parameters !== undefined) parameters = decoration.parameters;
  }
  return { description, parameters };
}

/** Compose wrapExecute chains around an innermost executor. */
export function composeExecution(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
  middlewares: readonly ToolMiddleware[],
  innermost: () => Promise<unknown>,
): Promise<unknown> {
  let chain = innermost;
  for (const middleware of [...middlewares].reverse()) {
    if (!middleware.wrapExecute) continue;
    const next = chain;
    chain = () => middleware.wrapExecute!(tool, input, ctx, next);
  }
  return chain();
}
