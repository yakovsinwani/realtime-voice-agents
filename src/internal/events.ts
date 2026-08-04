import { EventEmitter } from 'node:events';

type Listener = (...args: any[]) => void;

/**
 * EventEmitter with a typed event map. Listener errors are contained per
 * Node's usual semantics; `emit` returns whether any listener ran.
 */
export class TypedEmitter<Events extends Record<string, Listener>> {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    this.emitter.on(event, listener);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    this.emitter.once(event, listener);
    return this;
  }

  off<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    this.emitter.off(event, listener);
    return this;
  }

  removeAllListeners(event?: keyof Events & string): this {
    this.emitter.removeAllListeners(event);
    return this;
  }

  protected emit<K extends keyof Events & string>(event: K, ...args: Parameters<Events[K]>): boolean {
    return this.emitter.emit(event, ...args);
  }

  listenerCount(event: keyof Events & string): number {
    return this.emitter.listenerCount(event);
  }
}
