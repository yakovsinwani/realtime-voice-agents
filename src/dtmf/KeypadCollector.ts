/**
 * KeypadCollector — turns single DTMF keypresses into complete keypad entries.
 *
 * Callers type digits with ~1s pauses between them; the model should hear the
 * whole number once, not ten fragments. The collector buffers digits and
 * completes an entry on the submit key (`#`), on `maxDigits`, or after
 * `interDigitTimeoutMs` of no keypresses (the caller stopped without `#` —
 * flushing lets the agent react, typically "that's only N digits, please
 * retype"). The clear key (`*`) discards the buffer so the caller can start
 * over. Letters A–D and anything exotic are ignored.
 *
 * Pure state machine: no session, no transport. `CallSession` feeds it from
 * the Twilio `dtmf` frame (before emitting the raw `dtmf` event), turns the
 * hooks into `keypad.entry` / `keypad.cleared` events, and injects the default
 * user-turn message. Field-tested shape (workshop DTMF agents, Aug 2026).
 */

export type KeypadEntryReason = 'submit' | 'timeout' | 'maxDigits';

export interface KeypadEntry {
  /** The digits typed, in order (0–9 only). */
  digits: string;
  /** What completed the entry: the submit key, the inter-digit timeout, or `maxDigits`. */
  reason: KeypadEntryReason;
}

export interface KeypadOptions {
  /** Key that submits the current entry immediately. Default `'#'`. */
  submitKey?: string;
  /** Key that discards the current entry so the caller can start over. Default `'*'`. */
  clearKey?: string;
  /**
   * Silence after the last keypress that completes the entry anyway. Callers
   * pause ~1s between digits; default 4000.
   */
  interDigitTimeoutMs?: number;
  /**
   * Auto-submit once this many digits are buffered (an ID or phone number of
   * known length — the caller never has to press `#`). Default: unlimited.
   */
  maxDigits?: number;
  /**
   * Stop the agent mid-sentence on every keypress — typing means "I'm
   * answering". Bypasses the interruption guard like `session.interrupt()`.
   * Without it a flushed entry queues its readback behind stale speech.
   * Default true.
   */
  interruptOnKeypress?: boolean;
  /**
   * How a completed entry reaches the model: a function returning the text of
   * the user turn injected for it (default `defaultKeypadMessage`), or `false`
   * to inject nothing and handle `keypad.entry` yourself.
   */
  message?: ((entry: KeypadEntry) => string) | false;
  /**
   * User turn injected when the caller presses the clear key (default text
   * tells the model the caller is starting over), or `false` for none.
   */
  clearMessage?: string | false;
  /**
   * Appended to the agent instructions so the model knows what `[keypad]`
   * messages are (default `DEFAULT_KEYPAD_INSTRUCTIONS`), or `false` to leave
   * the instructions untouched — say it in your own prompt instead.
   */
  instructions?: string | false;
}

/** Host-facing handle: `session.keypad`. */
export interface KeypadHandle {
  /** Digits buffered so far (empty when keypad input is not configured). */
  readonly digits: string;
  /** Discard the buffer silently — no event, no message to the model. */
  clear(): void;
  /** Complete the buffered entry now (reason `'submit'`); no-op when empty. */
  submit(): void;
}

export const DEFAULT_KEYPAD_OPTIONS = {
  submitKey: '#',
  clearKey: '*',
  interDigitTimeoutMs: 4000,
  interruptOnKeypress: true,
} as const;

/**
 * Appended to the agent instructions when keypad input is enabled. Short and
 * neutral on purpose: what the messages are, not how to run the dialog.
 */
export const DEFAULT_KEYPAD_INSTRUCTIONS =
  'Keypad input: the caller may type on their phone keypad instead of speaking. ' +
  'Keypresses arrive as a user message starting with "[keypad]" that contains the typed digits — ' +
  'treat it as the caller\'s answer.';

/** Default text of the user turn injected for a completed entry. */
export function defaultKeypadMessage(entry: KeypadEntry): string {
  const { digits } = entry;
  return (
    `[keypad] I typed on my phone keypad: ${digits} — ${digits.length} digit${digits.length === 1 ? '' : 's'}. ` +
    `Digit by digit: ${[...digits].join(' ')}`
  );
}

/** Default text of the user turn injected when the caller presses the clear key. */
export const DEFAULT_KEYPAD_CLEAR_MESSAGE =
  '[keypad] I pressed star — I want to start over and retype from the beginning.';

/** What a keypress meant to the collector. */
export type KeypadKeyKind = 'digit' | 'submit' | 'clear' | 'ignored';

export interface KeypadCollectorHooks {
  onEntry: (entry: KeypadEntry) => void;
  onClear: (info: { discarded: string }) => void;
}

export class KeypadCollector implements KeypadHandle {
  private readonly submitKey: string;
  private readonly clearKey: string;
  private readonly interDigitTimeoutMs: number;
  private readonly maxDigits: number | undefined;
  private readonly hooks: KeypadCollectorHooks;
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(options: KeypadOptions, hooks: KeypadCollectorHooks) {
    this.submitKey = options.submitKey ?? DEFAULT_KEYPAD_OPTIONS.submitKey;
    this.clearKey = options.clearKey ?? DEFAULT_KEYPAD_OPTIONS.clearKey;
    this.interDigitTimeoutMs = options.interDigitTimeoutMs ?? DEFAULT_KEYPAD_OPTIONS.interDigitTimeoutMs;
    this.maxDigits = options.maxDigits !== undefined && options.maxDigits > 0 ? options.maxDigits : undefined;
    this.hooks = hooks;
  }

  get digits(): string {
    return this.buffer;
  }

  /** Feed one keypress (a Twilio `dtmf` frame). Returns what the key meant. */
  press(key: string): KeypadKeyKind {
    if (this.disposed) return 'ignored';
    if (key === this.submitKey) {
      this.cancelTimer();
      this.complete('submit');
      return 'submit';
    }
    if (key === this.clearKey) {
      this.cancelTimer();
      const discarded = this.buffer;
      this.buffer = '';
      this.hooks.onClear({ discarded });
      return 'clear';
    }
    if (!/^[0-9]$/.test(key)) return 'ignored';
    this.cancelTimer();
    this.buffer += key;
    if (this.maxDigits !== undefined && this.buffer.length >= this.maxDigits) {
      this.complete('maxDigits');
    } else {
      this.armTimer();
    }
    return 'digit';
  }

  clear(): void {
    this.cancelTimer();
    this.buffer = '';
  }

  submit(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.complete('submit');
  }

  /** Release the timer; pending digits are dropped (the call is over). */
  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.buffer = '';
  }

  private complete(reason: KeypadEntryReason): void {
    if (!this.buffer) return;
    const digits = this.buffer;
    this.buffer = '';
    this.hooks.onEntry({ digits, reason });
  }

  private armTimer(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.complete('timeout');
    }, this.interDigitTimeoutMs);
    this.timer.unref?.();
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
