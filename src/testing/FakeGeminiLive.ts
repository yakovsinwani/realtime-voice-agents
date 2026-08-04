/**
 * FakeGeminiLive — a scripted stand-in for @google/genai's live connection.
 *
 * Instead of a WebSocket server, this fakes the SDK seam: pass
 * `fake.connector` as the Gemini provider's `connector`. Each connect yields a
 * FakeGeminiSession that records client messages and lets tests push server
 * messages (audio parts, tool calls, transcriptions, resumption updates,
 * goAway) through the provider's callbacks.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type {
  GeminiConnectParams,
  GeminiLiveConnector,
  GeminiLiveSessionLike,
} from '../providers/gemini/GeminiLiveProvider.js';

export class FakeGeminiSession implements GeminiLiveSessionLike {
  readonly params: GeminiConnectParams;
  readonly realtimeInputs: Array<{ data: string; mimeType: string }> = [];
  readonly clientContents: Array<{ turns: Array<Record<string, any>>; turnComplete?: boolean }> = [];
  readonly toolResponses: Array<{ functionResponses: Array<Record<string, any>> }> = [];
  closed = false;

  constructor(params: GeminiConnectParams) {
    this.params = params;
  }

  // ---- SDK surface (called by the provider) --------------------------------

  sendRealtimeInput(input: { audio: { data: string; mimeType: string } }): void {
    this.realtimeInputs.push(input.audio);
  }

  sendClientContent(content: { turns: Array<Record<string, any>>; turnComplete?: boolean }): void {
    this.clientContents.push(content);
  }

  sendToolResponse(response: { functionResponses: Array<Record<string, any>> }): void {
    this.toolResponses.push(response);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.params.callbacks.onclose?.({ code: 1000, reason: 'client close' });
  }

  // ---- test driver (push server messages) ----------------------------------

  serverMessage(message: Record<string, unknown>): void {
    this.params.callbacks.onmessage(message);
  }

  completeSetup(): void {
    this.serverMessage({ setupComplete: {} });
  }

  /** Stream a model turn: PCM24k audio parts (+ transcript), then turnComplete. */
  sendAudioTurn(options: { pcm24kBase64Chunks: string[]; transcript?: string }): void {
    for (const chunk of options.pcm24kBase64Chunks) {
      this.serverMessage({
        serverContent: { modelTurn: { parts: [{ inlineData: { data: chunk, mimeType: 'audio/pcm;rate=24000' } }] } },
      });
    }
    if (options.transcript) {
      this.serverMessage({ serverContent: { outputTranscription: { text: options.transcript } } });
    }
    this.serverMessage({ serverContent: { turnComplete: true } });
  }

  sendToolCall(options: { name: string; args?: Record<string, unknown>; id?: string }): string {
    const id = options.id ?? `fn_${Math.random().toString(36).slice(2, 8)}`;
    this.serverMessage({ toolCall: { functionCalls: [{ id, name: options.name, args: options.args ?? {} }] } });
    return id;
  }

  sendInterrupted(): void {
    this.serverMessage({ serverContent: { interrupted: true } });
  }

  sendInputTranscription(text: string): void {
    this.serverMessage({ serverContent: { inputTranscription: { text } } });
  }

  sendResumptionUpdate(handle: string): void {
    this.serverMessage({ sessionResumptionUpdate: { resumable: true, newHandle: handle } });
  }

  sendGoAway(timeLeft: string): void {
    this.serverMessage({ goAway: { timeLeft } });
  }

  sendUsage(usage: Record<string, unknown>): void {
    this.serverMessage({ usageMetadata: usage });
  }

  /** Drop the connection from the server side. */
  drop(code = 1011, reason = 'fake drop'): void {
    if (this.closed) return;
    this.closed = true;
    this.params.callbacks.onclose?.({ code, reason });
  }
}

export class FakeGeminiLive {
  readonly sessions: FakeGeminiSession[] = [];
  /** Auto-send setupComplete on connect. Default true. */
  autoCompleteSetup = true;

  readonly connector: GeminiLiveConnector = async (params) => {
    const session = new FakeGeminiSession(params);
    this.sessions.push(session);
    params.callbacks.onopen?.();
    if (this.autoCompleteSetup) {
      queueMicrotask(() => session.completeSetup());
    }
    return session;
  };

  get latest(): FakeGeminiSession {
    const session = this.sessions[this.sessions.length - 1];
    if (!session) throw new Error('no gemini sessions yet');
    return session;
  }

  async waitForSessions(count: number, timeoutMs = 2000): Promise<FakeGeminiSession> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.sessions.length >= count) return this.sessions[count - 1]!;
      await delay(5);
    }
    throw new Error(`timed out waiting for ${count} gemini sessions (have ${this.sessions.length})`);
  }
}
