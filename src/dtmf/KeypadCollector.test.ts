import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KEYPAD_CLEAR_MESSAGE,
  KeypadCollector,
  defaultKeypadMessage,
  type KeypadEntry,
} from './KeypadCollector.js';

describe('KeypadCollector', () => {
  let entries: KeypadEntry[];
  let clears: Array<{ discarded: string }>;
  const make = (options: ConstructorParameters<typeof KeypadCollector>[0] = {}) =>
    new KeypadCollector(options, {
      onEntry: (entry) => entries.push(entry),
      onClear: (info) => clears.push(info),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    entries = [];
    clears = [];
  });
  afterEach(() => vi.useRealTimers());

  it('buffers digits and submits on # (reason submit); an empty # is a no-op', () => {
    const keypad = make();
    expect(keypad.press('#')).toBe('submit');
    expect(entries).toEqual([]);
    expect(keypad.press('1')).toBe('digit');
    expect(keypad.press('2')).toBe('digit');
    expect(keypad.digits).toBe('12');
    expect(keypad.press('#')).toBe('submit');
    expect(entries).toEqual([{ digits: '12', reason: 'submit' }]);
    expect(keypad.digits).toBe('');
  });

  it('flushes after the inter-digit timeout (reason timeout); every key restarts the clock', () => {
    const keypad = make({ interDigitTimeoutMs: 1000 });
    keypad.press('4');
    vi.advanceTimersByTime(900);
    keypad.press('5'); // 900 ms later — still inside the window, clock restarts
    vi.advanceTimersByTime(900);
    expect(entries).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(entries).toEqual([{ digits: '45', reason: 'timeout' }]);
  });

  it('auto-submits at maxDigits (reason maxDigits) without # or a timeout', () => {
    const keypad = make({ maxDigits: 3 });
    keypad.press('7');
    keypad.press('8');
    expect(entries).toEqual([]);
    keypad.press('9');
    expect(entries).toEqual([{ digits: '789', reason: 'maxDigits' }]);
    expect(keypad.digits).toBe('');
    vi.advanceTimersByTime(10_000);
    expect(entries).toHaveLength(1); // no second (timeout) flush of an empty buffer
  });

  it('* discards the buffer and reports what it held; a later * with nothing buffered still reports', () => {
    const keypad = make();
    keypad.press('1');
    keypad.press('2');
    expect(keypad.press('*')).toBe('clear');
    expect(clears).toEqual([{ discarded: '12' }]);
    expect(keypad.digits).toBe('');
    vi.advanceTimersByTime(10_000);
    expect(entries).toEqual([]); // the pending timeout died with the buffer
    keypad.press('*');
    expect(clears).toEqual([{ discarded: '12' }, { discarded: '' }]);
  });

  it('ignores A–D and anything that is not a single digit', () => {
    const keypad = make();
    for (const key of ['A', 'B', 'C', 'D', '', '12', 'x']) expect(keypad.press(key)).toBe('ignored');
    expect(keypad.digits).toBe('');
    vi.advanceTimersByTime(10_000);
    expect(entries).toEqual([]);
  });

  it('honors custom submit/clear keys', () => {
    const keypad = make({ submitKey: '*', clearKey: '#' });
    keypad.press('1');
    expect(keypad.press('#')).toBe('clear');
    expect(clears).toEqual([{ discarded: '1' }]);
    keypad.press('2');
    expect(keypad.press('*')).toBe('submit');
    expect(entries).toEqual([{ digits: '2', reason: 'submit' }]);
  });

  it('handle: clear() is silent, submit() completes programmatically, dispose() drops pending digits', () => {
    const keypad = make();
    keypad.press('3');
    keypad.clear();
    expect(keypad.digits).toBe('');
    expect(clears).toEqual([]); // host-side clear is not a caller "start over"
    vi.advanceTimersByTime(10_000);
    expect(entries).toEqual([]);

    keypad.press('4');
    keypad.submit();
    expect(entries).toEqual([{ digits: '4', reason: 'submit' }]);
    keypad.submit(); // empty — no-op
    expect(entries).toHaveLength(1);

    keypad.press('5');
    keypad.dispose();
    vi.advanceTimersByTime(10_000);
    expect(entries).toHaveLength(1);
    expect(keypad.press('6')).toBe('ignored');
    keypad.submit();
    expect(entries).toHaveLength(1);
  });

  it('default messages: digit-by-digit readback, singular/plural, start-over wording', () => {
    expect(defaultKeypadMessage({ digits: '0541234567', reason: 'submit' })).toBe(
      '[keypad] I typed on my phone keypad: 0541234567 — 10 digits. Digit by digit: 0 5 4 1 2 3 4 5 6 7',
    );
    expect(defaultKeypadMessage({ digits: '7', reason: 'timeout' })).toContain('— 1 digit.');
    expect(DEFAULT_KEYPAD_CLEAR_MESSAGE).toMatch(/^\[keypad\] /);
  });
});
