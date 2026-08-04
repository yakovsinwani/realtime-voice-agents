/**
 * Tool execution strategies end-to-end: dispatch, deferred (both completion
 * paths), humanInTheLoop (approve / reject / timeout), and idle nudges.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../agents/Agent.js';
import { tool } from '../tools/tool.js';
import { FakeOpenAIServer } from '../testing/FakeOpenAIServer.js';
import { FakeTwilioMediaStream } from '../testing/FakeTwilioMediaStream.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible/OpenAICompatibleProvider.js';
import { TwilioRealtimeBridge } from './TwilioRealtimeBridge.js';
import type { BridgeConfig } from './config.js';
import type { CallSession } from './CallSession.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const functionOutputs = (server: FakeOpenAIServer) =>
  server.latest.received.filter(
    (f) => f.type === 'conversation.item.create' && f.item?.type === 'function_call_output',
  );

describe('tool strategies', () => {
  let server: FakeOpenAIServer;
  let bridge: TwilioRealtimeBridge;
  let fake: FakeTwilioMediaStream;

  const makeBridge = (agent: Agent, overrides: Partial<BridgeConfig> = {}) =>
    new TwilioRealtimeBridge({
      agent,
      provider: ({ logger }) =>
        new OpenAICompatibleProvider(
          { apiKey: 'test', model: 'gpt-realtime', baseUrl: server.url },
          logger,
        ),
      ...overrides,
    });

  const connectCall = async (): Promise<CallSession> => {
    fake = new FakeTwilioMediaStream();
    bridge.handleConnection(fake);
    fake.connect();
    await waitFor(() => bridge.getSession(fake.callSid)?.state === 'active', 2000, 'active session');
    return bridge.getSession(fake.callSid)!;
  };

  beforeEach(async () => {
    server = await FakeOpenAIServer.start();
  });

  afterEach(async () => {
    await bridge?.close();
    await server.close();
  });

  it('dispatch: immediate queued ack; completion emits an event but sends nothing more', async () => {
    let resolveWork!: () => void;
    const work = new Promise<void>((r) => (resolveWork = r));
    const dispatchTool = tool({
      name: 'send_confirmation',
      description: 'send sms',
      parameters: z.object({}),
      strategy: 'dispatch',
      execute: async () => {
        await work;
        return { sent: true };
      },
    });
    bridge = makeBridge(new Agent({ name: 'A', instructions: 'x', tools: [dispatchTool] }));
    const session = await connectCall();
    const completed: string[] = [];
    session.on('tool.completed', (i) => completed.push(i.toolName));

    server.latest.sendToolCall({ name: 'send_confirmation', argumentsJson: '{}' });

    // The ack arrives BEFORE the work finishes.
    await waitFor(() => functionOutputs(server).length === 1, 2000, 'queued ack');
    expect(JSON.parse(functionOutputs(server)[0]!.item.output).status).toBe('queued');
    expect(completed).toHaveLength(0);

    resolveWork();
    await waitFor(() => completed.includes('send_confirmation'), 2000, 'completion event');
    // Still exactly one function output — the real result is never sent for dispatch.
    expect(functionOutputs(server)).toHaveLength(1);
  });

  it('deferred: pending ack, then the result is injected as a system turn', async () => {
    let resolveWork!: (v: { report: string }) => void;
    const work = new Promise<{ report: string }>((r) => (resolveWork = r));
    const deferredTool = tool({
      name: 'run_report',
      description: 'slow report',
      parameters: z.object({}),
      strategy: 'deferred',
      timeoutMs: 5000,
      execute: async () => work,
    });
    bridge = makeBridge(new Agent({ name: 'A', instructions: 'x', tools: [deferredTool] }));
    await connectCall();

    server.latest.sendToolCall({ name: 'run_report', argumentsJson: '{}' });
    await waitFor(() => functionOutputs(server).length === 1, 2000, 'pending ack');
    expect(JSON.parse(functionOutputs(server)[0]!.item.output).status).toBe('pending');

    resolveWork({ report: 'all good' });
    const injection = await server.latest.waitForEvent(
      (f) =>
        f.type === 'conversation.item.create' &&
        f.item?.role === 'system' &&
        typeof f.item?.content?.[0]?.text === 'string' &&
        f.item.content[0].text.includes('run_report'),
    );
    expect(injection.item.content[0].text).toContain('all good');
    await server.latest.waitForEvent('response.create');
  });

  it('deferred: session.submitToolResult wins over a slow execute()', async () => {
    const never = new Promise<{ verdict: string }>(() => {});
    const deferredTool = tool({
      name: 'external_check',
      description: 'completed by a webhook',
      parameters: z.object({}),
      strategy: 'deferred',
      timeoutMs: 60_000,
      execute: async () => never,
    });
    bridge = makeBridge(new Agent({ name: 'A', instructions: 'x', tools: [deferredTool] }));
    const session = await connectCall();

    const callId = server.latest.sendToolCall({ name: 'external_check', argumentsJson: '{}' });
    await waitFor(() => functionOutputs(server).length === 1, 2000, 'pending ack');

    session.submitToolResult(callId, { verdict: 'approved externally' });
    const injection = await server.latest.waitForEvent(
      (f) =>
        f.type === 'conversation.item.create' &&
        f.item?.role === 'system' &&
        typeof f.item?.content?.[0]?.text === 'string' &&
        f.item.content[0].text.includes('external_check'),
    );
    expect(injection.item.content[0].text).toContain('approved externally');
  });

  it('humanInTheLoop: approval event fires; approve runs the tool and delivers', async () => {
    const refund = tool({
      name: 'issue_refund',
      description: 'refund money',
      parameters: z.object({ amount: z.number() }),
      strategy: 'humanInTheLoop',
      execute: async ({ amount }) => ({ refunded: amount }),
    });
    bridge = makeBridge(new Agent({ name: 'A', instructions: 'x', tools: [refund] }));
    const session = await connectCall();
    const approvals: Array<{ approvalId: string; input: unknown }> = [];
    session.on('tool.approval.required', (req) => approvals.push(req));

    server.latest.sendToolCall({ name: 'issue_refund', argumentsJson: '{"amount":50}' });
    await waitFor(() => approvals.length === 1, 2000, 'approval request');
    expect(approvals[0]!.input).toEqual({ amount: 50 });
    expect(functionOutputs(server)).toHaveLength(0); // model still waiting

    session.approveTool(approvals[0]!.approvalId, { amount: 25 }); // edited input
    await waitFor(() => functionOutputs(server).length === 1, 2000, 'approved result');
    expect(JSON.parse(functionOutputs(server)[0]!.item.output)).toEqual({ refunded: 25 });
  });

  it('humanInTheLoop: reject returns an operator-rejection to the model', async () => {
    const risky = tool({
      name: 'delete_account',
      description: 'dangerous',
      parameters: z.object({}),
      strategy: 'humanInTheLoop',
      execute: async () => ({ deleted: true }),
    });
    bridge = makeBridge(new Agent({ name: 'A', instructions: 'x', tools: [risky] }));
    const session = await connectCall();
    const approvals: string[] = [];
    session.on('tool.approval.required', (req) => approvals.push(req.approvalId));

    server.latest.sendToolCall({ name: 'delete_account', argumentsJson: '{}' });
    await waitFor(() => approvals.length === 1, 2000, 'approval request');
    session.rejectTool(approvals[0]!, 'not allowed on calls');
    await waitFor(() => functionOutputs(server).length === 1, 2000, 'rejection result');
    const payload = JSON.parse(functionOutputs(server)[0]!.item.output);
    expect(payload.error).toBe('rejected');
    expect(payload.message).toBe('not allowed on calls');
  });

  it('humanInTheLoop: unanswered approvals time out into a rejection', async () => {
    const slow = tool({
      name: 'needs_human',
      description: 'x',
      parameters: z.object({}),
      strategy: 'humanInTheLoop',
      approvalTimeoutMs: 150,
      execute: async () => ({ ok: true }),
    });
    bridge = makeBridge(new Agent({ name: 'A', instructions: 'x', tools: [slow] }));
    await connectCall();
    server.latest.sendToolCall({ name: 'needs_human', argumentsJson: '{}' });
    await waitFor(() => functionOutputs(server).length === 1, 2000, 'timeout rejection');
    expect(JSON.parse(functionOutputs(server)[0]!.item.output).error).toBe('rejected');
  });

  it('middleware wrapExecute runs around tool execution (bridge.use)', async () => {
    const audited: string[] = [];
    const auditTool = tool({
      name: 'plain',
      description: 'x',
      parameters: z.object({}),
      execute: async () => ({ done: true }),
    });
    bridge = makeBridge(new Agent({ name: 'A', instructions: 'x', tools: [auditTool] }));
    bridge.use({
      decorate: (t) => ({ description: `${t.description} [audited]` }),
      wrapExecute: async (t, _input, _ctx, next) => {
        audited.push(`before:${t.name}`);
        const result = await next();
        audited.push(`after:${t.name}`);
        return result;
      },
    });
    await connectCall();

    const sessionUpdate = await server.latest.waitForEvent('session.update');
    const declared = (sessionUpdate.session as any).tools.find((t: any) => t.name === 'plain');
    expect(declared.description).toBe('x [audited]');

    server.latest.sendToolCall({ name: 'plain', argumentsJson: '{}' });
    await waitFor(() => functionOutputs(server).length === 1, 2000, 'result');
    expect(audited).toEqual(['before:plain', 'after:plain']);
  });

  it('idle nudges escalate and then end the call', async () => {
    bridge = makeBridge(new Agent({ name: 'A', instructions: 'x' }), {
      session: {
        idle: {
          timeoutSeconds: 0.15,
          prompts: ['Ask if they are still there.'],
          maxNudges: 1,
          goodbye: 'Say goodbye now.',
        },
        hangup: { markTimeoutMs: 400 },
      },
    });
    const session = await connectCall();
    let endedReason = '';
    session.on('call.ended', ({ reason }) => (endedReason = reason));

    // Greeting response (idle timer arms after its playback finishes).
    await server.latest.waitForEvent('response.create');
    server.latest.sendAudioResponse({ responseId: 'greet', chunks: ['//8='] });
    await waitFor(() => fake.sentMediaPayloads.length >= 1, 2000, 'greeting at Twilio');
    fake.playAll();

    // First idle timeout → nudge response.create with the prompt.
    const nudge = await server.latest.waitForEvent(
      (f) => f.type === 'response.create' && f.response?.instructions === 'Ask if they are still there.',
    );
    expect(nudge).toBeTruthy();
    server.latest.sendAudioResponse({ responseId: 'nudge1', chunks: ['//8='] });
    await waitFor(() => fake.sentMediaPayloads.length >= 2, 2000, 'nudge audio at Twilio');
    fake.playAll();

    // Second timeout → goodbye + hangup (watchdog covers the unplayed goodbye).
    await server.latest.waitForEvent(
      (f) => f.type === 'response.create' && f.response?.instructions === 'Say goodbye now.',
    );
    await waitFor(() => session.state === 'ended', 3000, 'idle teardown');
    expect(endedReason).toBe('idle-timeout');
  });
});
