import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { composeExecution, decorateTool, type ToolMiddleware } from './middleware.js';
import { tool } from './tool.js';

const baseTool = tool({
  name: 'demo',
  description: 'original description',
  parameters: z.object({ x: z.number() }),
  execute: async ({ x }) => ({ doubled: x * 2 }),
});

const fakeCtx = {} as any;

describe('decorateTool', () => {
  it('applies decorations in registration order (later wins)', () => {
    const a: ToolMiddleware = { decorate: () => ({ description: 'from A' }) };
    const b: ToolMiddleware = {
      decorate: (t) => ({ description: `${t.description} + B suffix` }),
    };
    const result = decorateTool(baseTool, [a, b]);
    // b sees the ORIGINAL tool but its decoration is applied after a's.
    expect(result.description).toBe('original description + B suffix');
    expect(result.parameters).toBe(baseTool.parametersJsonSchema);
  });
});

describe('composeExecution', () => {
  it('first-registered middleware wraps outermost', async () => {
    const order: string[] = [];
    const outer: ToolMiddleware = {
      wrapExecute: async (_t, _i, _c, next) => {
        order.push('outer:before');
        const result = await next();
        order.push('outer:after');
        return result;
      },
    };
    const inner: ToolMiddleware = {
      wrapExecute: async (_t, _i, _c, next) => {
        order.push('inner:before');
        const result = await next();
        order.push('inner:after');
        return result;
      },
    };
    const result = await composeExecution(baseTool, { x: 2 }, fakeCtx, [outer, inner], async () => {
      order.push('execute');
      return { ok: true };
    });
    expect(order).toEqual(['outer:before', 'inner:before', 'execute', 'inner:after', 'outer:after']);
    expect(result).toEqual({ ok: true });
  });

  it('a middleware can short-circuit without calling next', async () => {
    let executed = false;
    const gate: ToolMiddleware = {
      wrapExecute: async () => ({ status: 'blocked_by_policy' }),
    };
    const result = await composeExecution(baseTool, { x: 1 }, fakeCtx, [gate], async () => {
      executed = true;
      return { ok: true };
    });
    expect(result).toEqual({ status: 'blocked_by_policy' });
    expect(executed).toBe(false);
  });
});
