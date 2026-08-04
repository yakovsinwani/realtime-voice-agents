import type { SessionContext } from '../tools/context.js';
import type { Tool } from '../tools/tool.js';

export interface AgentDefinition {
  /** Human-readable name ("Billing Department"). */
  name: string;
  /** Stable id used in handoff tool names; derived from name if omitted. */
  id?: string;
  /** System instructions — static or computed from session context. */
  instructions: string | ((context: SessionContext) => string);
  voice?: string;
  /** Provider model override for this agent (used where supported). */
  model?: string;
  tools?: Tool[];
  /** Agents this one can hand the call to (transfer tools are generated). */
  handoffs?: Agent[];
  /** Shown to the transferring model as the transfer tool's description. */
  handoffDescription?: string;
  /** Provider-native session options for this agent (escape hatch). */
  providerOptions?: Record<string, unknown>;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new Error(`cannot derive an agent id from name "${name}"`);
  return slug;
}

export class Agent {
  readonly id: string;
  readonly name: string;
  readonly voice?: string;
  readonly model?: string;
  readonly tools: Tool[];
  readonly handoffs: Agent[];
  readonly handoffDescription?: string;
  readonly providerOptions?: Record<string, unknown>;
  private readonly instructionsSource: AgentDefinition['instructions'];

  constructor(definition: AgentDefinition) {
    this.id = definition.id ?? slugify(definition.name);
    this.name = definition.name;
    this.voice = definition.voice;
    this.model = definition.model;
    this.tools = definition.tools ?? [];
    this.handoffs = definition.handoffs ?? [];
    this.handoffDescription = definition.handoffDescription;
    this.providerOptions = definition.providerOptions;
    this.instructionsSource = definition.instructions;
  }

  resolveInstructions(context: SessionContext): string {
    return typeof this.instructionsSource === 'function'
      ? this.instructionsSource(context)
      : this.instructionsSource;
  }
}

/**
 * Walk the handoff graph (BFS) from a root agent. Cycles are fine — swarms
 * commonly hand back and forth. Two different Agent instances claiming the
 * same id is a configuration error caught here, at session build.
 */
export function collectAgentGraph(root: Agent): Map<string, Agent> {
  const agents = new Map<string, Agent>();
  const queue: Agent[] = [root];
  while (queue.length > 0) {
    const agent = queue.shift()!;
    const existing = agents.get(agent.id);
    if (existing === agent) continue;
    if (existing) {
      throw new Error(`duplicate agent id "${agent.id}" (two different Agent instances)`);
    }
    agents.set(agent.id, agent);
    queue.push(...agent.handoffs);
  }
  return agents;
}
