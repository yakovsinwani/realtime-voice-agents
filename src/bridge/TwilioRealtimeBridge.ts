/**
 * TwilioRealtimeBridge — the entry point.
 *
 * Framework-agnostic: hand `handleConnection` any ws-shaped socket from
 * @fastify/websocket, express-ws, or a raw `ws` server. The bridge runs the
 * start-frame handshake (bounded, validated), resolves per-call agent and
 * options (multi-tenant hooks), and spins up one CallSession per call.
 */

import type { IncomingMessage } from 'node:http';
import { Agent } from '../agents/Agent.js';
import { TypedEmitter } from '../internal/events.js';
import { noopLogger, type Logger } from '../logging/logger.js';
import { InMemorySessionStore } from '../session/InMemorySessionStore.js';
import type { SessionStore } from '../session/SessionStore.js';
import { TwilioMediaTransport, type WebSocketLike } from '../twilio/transport.js';
import { TwilioRestClient } from '../twilio/rest.js';
import { CallSession } from './CallSession.js';
import type { BridgeConfig, SessionOptions } from './config.js';
import { resolveSessionOptions } from './config.js';
import type { BridgeEventMap } from './events.js';
import type { CallEndReason } from './state.js';

const MAX_ANSWERED_EARLY_ENTRIES = 1000;

export class TwilioRealtimeBridge extends TypedEmitter<BridgeEventMap> {
  private readonly config: BridgeConfig;
  private readonly logger: Logger;
  private readonly store: SessionStore;
  private readonly rest?: TwilioRestClient;
  private readonly sessionsBySid = new Map<string, CallSession>();
  /** Status callbacks can beat the media stream; remember early answers. */
  private readonly answeredEarly = new Set<string>();
  private closed = false;

  constructor(config: BridgeConfig) {
    super();
    this.config = config;
    this.logger = config.logger ?? noopLogger;
    this.store = config.store ?? new InMemorySessionStore();
    if (config.twilio) {
      this.rest = new TwilioRestClient({
        accountSid: config.twilio.accountSid,
        authToken: config.twilio.authToken,
        callerId: config.twilio.callerId,
      });
    }
  }

  /** Attach one incoming Twilio Media Stream WebSocket. */
  handleConnection(ws: WebSocketLike, request?: IncomingMessage): void {
    if (this.closed) {
      try {
        ws.close(1013, 'bridge closed');
      } catch {
        /* socket already dead */
      }
      return;
    }
    const transport = new TwilioMediaTransport(ws);
    void this.handshake(transport, request);
  }

  getSession(callSid: string): CallSession | undefined {
    return this.sessionsBySid.get(callSid);
  }

  sessions(): ReadonlyMap<string, CallSession> {
    return this.sessionsBySid;
  }

  /**
   * Feed the outbound `answered` signal from your Twilio status callback so
   * agent-initiated greetings fire when the human actually picks up.
   */
  notifyAnswered(callSid: string): void {
    const session = this.sessionsBySid.get(callSid);
    if (session) {
      session.notifyAnswered();
      return;
    }
    this.answeredEarly.add(callSid);
    if (this.answeredEarly.size > MAX_ANSWERED_EARLY_ENTRIES) {
      const oldest = this.answeredEarly.values().next().value;
      if (oldest !== undefined) this.answeredEarly.delete(oldest);
    }
  }

  /** Deterministically end every active session and stop accepting new ones. */
  async close(): Promise<void> {
    this.closed = true;
    const active = [...this.sessionsBySid.values()];
    await Promise.allSettled(active.map((session) => session.end('bridge-closed')));
    this.sessionsBySid.clear();
  }

  private async handshake(transport: TwilioMediaTransport, request?: IncomingMessage): Promise<void> {
    const handshakeOptions =
      typeof this.config.session === 'object' ? this.config.session.handshake : undefined;
    let start;
    try {
      start = await transport.awaitStart({
        timeoutMs: handshakeOptions?.timeoutMs,
        maxPreStartMessages: handshakeOptions?.maxPreStartMessages,
      });
    } catch (error) {
      this.logger.warn('media stream handshake failed', { error: String(error) });
      this.emit('connection.rejected', { reason: 'no-start-frame' });
      transport.close(1008, 'no start frame');
      return;
    }

    const callSid = start.start.callSid;
    try {
      if (this.config.validateConnection) {
        const valid = await this.config.validateConnection(start, request);
        if (!valid) {
          this.emit('connection.rejected', { reason: 'unauthorized' });
          transport.close(1008, 'unauthorized');
          return;
        }
      }
      if (this.sessionsBySid.has(callSid)) {
        this.emit('connection.rejected', { reason: 'duplicate-call' });
        transport.close(1008, 'duplicate stream for call');
        return;
      }

      const agent =
        typeof this.config.agent === 'function' ? await this.config.agent(start) : this.config.agent;
      if (!(agent instanceof Agent)) {
        throw new Error('BridgeConfig.agent must resolve to an Agent instance');
      }
      const partialOptions: Partial<SessionOptions> | undefined =
        typeof this.config.session === 'function'
          ? await this.config.session(start)
          : this.config.session;
      const options = resolveSessionOptions(partialOptions);

      const answeredEarly = this.answeredEarly.delete(callSid);
      const session = new CallSession({
        transport,
        start,
        providerFactory: this.config.provider,
        agent,
        options,
        store: this.store,
        logger: this.logger,
        builtinTools: this.config.builtinTools,
        rest: this.rest,
        restCallerId: this.config.twilio?.callerId,
        answeredEarly,
        onEnded: (sid, reason) => this.onSessionEnded(sid, reason),
      });
      this.sessionsBySid.set(callSid, session);
      this.emit('session.started', session);
      await session.begin();
    } catch (error) {
      this.logger.error('failed to establish call session', { callSid, error: String(error) });
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      this.sessionsBySid.delete(callSid);
      transport.close(1011, 'session setup failed');
    }
  }

  private onSessionEnded(callSid: string, reason: CallEndReason): void {
    this.sessionsBySid.delete(callSid);
    this.emit('session.ended', { callSid, reason });
  }
}
