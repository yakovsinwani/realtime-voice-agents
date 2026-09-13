import { describe, expect, it } from 'vitest';
import { TypedEmitter } from './events.js';
import type { CallSession } from '../bridge/CallSession.js';
import type { TwilioRealtimeBridge } from '../bridge/TwilioRealtimeBridge.js';

interface ProbeEvents {
  ping: (value: number) => void;
}

class Probe extends TypedEmitter<ProbeEvents> {
  fire(): boolean {
    return this.emit('ping', 42);
  }
}

describe('TypedEmitter event-name safety', () => {
  it('delivers declared events to listeners', () => {
    const probe = new Probe();
    let got = 0;
    probe.on('ping', (value) => (got = value));
    probe.fire();
    expect(got).toBe(42);
  });

  it('removeAllListeners() with no argument detaches everything (Node treats an explicit undefined as an event name)', () => {
    const probe = new Probe();
    let hits = 0;
    probe.on('ping', () => hits++);
    probe.once('ping', () => hits++);
    probe.removeAllListeners();
    probe.fire();
    expect(hits).toBe(0);
    expect(probe.listenerCount('ping')).toBe(0);
    // The single-event form still works too.
    probe.on('ping', () => hits++);
    probe.removeAllListeners('ping');
    probe.fire();
    expect(hits).toBe(0);
  });

  it('drops error emits with no listener instead of throwing', () => {
    class ErrorProbe extends TypedEmitter<{ error: (error: Error) => void }> {
      trip(): boolean {
        return this.emit('error', new Error('boom'));
      }
    }
    expect(new ErrorProbe().trip()).toBe(false);
  });

  // The @ts-expect-error directives below are the actual assertions: if the
  // event maps ever regain a string index signature (the bug where
  // `session.on("tool.succeeded", ...)` compiled but never fired), tsc fails
  // `npm run typecheck` with "Unused '@ts-expect-error' directive".
  it('rejects unknown event names at compile time (enforced by tsc)', () => {
    const probe = new Probe();
    // @ts-expect-error unknown emitter event names must not compile
    probe.on('pong', () => {});

    const typeOnly = (session: CallSession, bridge: TwilioRealtimeBridge) => {
      // @ts-expect-error the real session event is 'tool.completed'
      session.on('tool.succeeded', () => {});
      // @ts-expect-error misspelled bridge event names must not compile
      bridge.on('sesion.started', () => {});
    };
    expect(typeOnly).toBeTypeOf('function');
  });
});
