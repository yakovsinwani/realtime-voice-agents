/**
 * FakeOpenAIServer — a scripted GA-protocol Realtime server on a local port.
 *
 * Speaks just enough of the wire protocol to exercise the provider and the
 * full bridge without network or API keys: session.created on connect,
 * session.updated on session.update, plus push helpers for audio responses,
 * tool calls, VAD events, and transcripts. Every client frame is recorded for
 * assertions.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeOpenAIServerOptions {
  /** Auto-ack session.update with session.updated. Default true. */
  autoAckSessionUpdate?: boolean;
}

export interface FakeAudioResponseOptions {
  responseId?: string;
  itemId?: string;
  /** Base64 μ-law chunks to stream as output_audio deltas. */
  chunks: string[];
  transcript?: string;
  usage?: Record<string, unknown>;
  /** Emit response.done after the deltas. Default true. */
  complete?: boolean;
}

let responseCounter = 0;

export class FakeOpenAIConnection {
  readonly socket: WebSocket;
  /** Every parsed client → server frame, in order. */
  readonly received: Array<Record<string, any>> = [];
  private readonly server: FakeOpenAIServer;

  constructor(server: FakeOpenAIServer, socket: WebSocket) {
    this.server = server;
    this.socket = socket;
  }

  /** Base64 payloads from input_audio_buffer.append frames. */
  get appendedAudio(): string[] {
    return this.received
      .filter((f) => f.type === 'input_audio_buffer.append')
      .map((f) => f.audio as string);
  }

  eventsOfType(type: string): Array<Record<string, any>> {
    return this.received.filter((f) => f.type === type);
  }

  async waitForEvent(
    predicate: string | ((frame: Record<string, any>) => boolean),
    timeoutMs = 2000,
  ): Promise<Record<string, any>> {
    const matches =
      typeof predicate === 'string'
        ? (frame: Record<string, any>) => frame.type === predicate
        : predicate;
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    while (Date.now() < deadline) {
      for (; seen < this.received.length; seen++) {
        const frame = this.received[seen]!;
        if (matches(frame)) return frame;
      }
      await delay(5);
    }
    throw new Error(
      `timed out waiting for client event; got: ${this.received.map((f) => f.type).join(', ')}`,
    );
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Script a complete assistant audio response (created → deltas → done). */
  sendAudioResponse(options: FakeAudioResponseOptions): { responseId: string; itemId: string } {
    const responseId = options.responseId ?? `resp_${++responseCounter}`;
    const itemId = options.itemId ?? `item_${responseCounter}`;
    this.send({ type: 'response.created', response: { id: responseId } });
    this.send({
      type: 'response.output_item.added',
      response_id: responseId,
      item: { id: itemId, type: 'message' },
    });
    for (const chunk of options.chunks) {
      this.send({
        type: 'response.output_audio.delta',
        response_id: responseId,
        item_id: itemId,
        delta: chunk,
      });
    }
    if (options.transcript) {
      this.send({
        type: 'response.output_audio_transcript.delta',
        response_id: responseId,
        delta: options.transcript,
      });
      this.send({
        type: 'response.output_audio_transcript.done',
        response_id: responseId,
        transcript: options.transcript,
      });
    }
    if (options.complete !== false) {
      this.send({
        type: 'response.done',
        response: { id: responseId, status: 'completed', usage: options.usage },
      });
    }
    return { responseId, itemId };
  }

  sendToolCall(options: {
    name: string;
    argumentsJson?: string;
    callId?: string;
    responseId?: string;
  }): string {
    const callId = options.callId ?? `call_${++responseCounter}`;
    const responseId = options.responseId ?? `resp_${responseCounter}`;
    this.send({ type: 'response.created', response: { id: responseId } });
    this.send({
      type: 'response.function_call_arguments.done',
      response_id: responseId,
      item_id: `item_${responseCounter}`,
      call_id: callId,
      name: options.name,
      arguments: options.argumentsJson ?? '{}',
    });
    this.send({ type: 'response.done', response: { id: responseId, status: 'completed' } });
    return callId;
  }

  sendSpeechStarted(): void {
    this.send({ type: 'input_audio_buffer.speech_started' });
  }

  sendSpeechStopped(): void {
    this.send({ type: 'input_audio_buffer.speech_stopped' });
  }

  sendUserTranscript(text: string): void {
    this.send({ type: 'conversation.item.input_audio_transcription.completed', transcript: text });
  }

  sendError(error: Record<string, unknown>): void {
    this.send({ type: 'error', error });
  }

  drop(code = 1011, reason = 'fake server drop'): void {
    this.socket.close(code, reason);
  }
}

export class FakeOpenAIServer {
  readonly connections: FakeOpenAIConnection[] = [];
  private readonly wss: WebSocketServer;
  private readonly options: FakeOpenAIServerOptions;
  readonly url: string;

  private constructor(wss: WebSocketServer, url: string, options: FakeOpenAIServerOptions) {
    this.wss = wss;
    this.url = url;
    this.options = options;
    wss.on('connection', (socket) => {
      const connection = new FakeOpenAIConnection(this, socket);
      this.connections.push(connection);
      socket.on('message', (raw) => {
        let frame: Record<string, any>;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return;
        }
        connection.received.push(frame);
        if (frame.type === 'session.update' && this.options.autoAckSessionUpdate !== false) {
          connection.send({ type: 'session.updated', session: frame.session });
        }
      });
      socket.send(JSON.stringify({ type: 'session.created', session: {} }));
    });
  }

  static async start(options: FakeOpenAIServerOptions = {}): Promise<FakeOpenAIServer> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    const address = wss.address();
    if (typeof address === 'string' || address === null) throw new Error('no server address');
    return new FakeOpenAIServer(wss, `ws://127.0.0.1:${address.port}`, options);
  }

  get latest(): FakeOpenAIConnection {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) throw new Error('no connections yet');
    return connection;
  }

  async waitForConnection(timeoutMs = 2000): Promise<FakeOpenAIConnection> {
    const count = this.connections.length;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connections.length > count) return this.connections[this.connections.length - 1]!;
      await delay(5);
    }
    throw new Error('timed out waiting for a provider connection');
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      try {
        connection.socket.terminate();
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
