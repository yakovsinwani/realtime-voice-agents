/**
 * Swarm-style handoffs (LangGraph-inspired): every agent listed in
 * `handoffs` gets an auto-generated `transfer_to_<id>` tool. The tool's
 * execute returns a Command-like directive; the session intercepts it,
 * delivers the tool result, and performs the swap — so tool-initiated and
 * programmatic (`session.handoffTo`) handoffs share one code path.
 */

import * as z from 'zod';
import type { Agent } from './Agent.js';
import { tool, type Tool } from '../tools/tool.js';

const HANDOFF_MARKER = '__twilioRealtimeAgentsHandoff' as const;

export interface HandoffDirective {
  [HANDOFF_MARKER]: true;
  targetAgentId: string;
  reason?: string;
}

export function isHandoffDirective(value: unknown): value is HandoffDirective {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[HANDOFF_MARKER] === true
  );
}

export function handoffToolName(agentId: string): string {
  return `transfer_to_${agentId}`;
}

export function createHandoffTool(target: Agent): Tool {
  return tool({
    name: handoffToolName(target.id),
    description:
      target.handoffDescription ??
      `Transfer the conversation to ${target.name}. Use when the caller's request is better handled by ${target.name}.`,
    parameters: z.object({
      reason: z
        .string()
        .optional()
        .describe('Brief context for the receiving agent about why the caller was transferred'),
    }),
    execute: async (input): Promise<HandoffDirective> => ({
      [HANDOFF_MARKER]: true,
      targetAgentId: target.id,
      reason: (input as { reason?: string }).reason,
    }),
  });
}
