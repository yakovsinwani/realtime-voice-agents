/**
 * Replay formatting for reconnect/handoff re-injection.
 *
 * The shape matters operationally: a flat `Agent:` replay made every incoming
 * agent re-derive intent and transfer on, ping-ponging the caller between
 * agents (field bug, Aug 2026). Attribution + `[transfer]` lines are the fix.
 */

import { describe, expect, it } from 'vitest';
import { formatTranscriptForInjection, type TranscriptEntry } from './transcript.js';

const NAMES = new Map([
  ['receptionist', 'Receptionist'],
  ['billing', 'Billing Department'],
]);

const CONVERSATION: TranscriptEntry[] = [
  { role: 'user', text: 'I need a refund on invoice 12', timestampMs: 1000 },
  { role: 'agent', text: 'Let me get billing for you.', timestampMs: 2000, agentId: 'receptionist' },
  { role: 'agent', text: 'Hi, I can pull that invoice up.', timestampMs: 4000, agentId: 'billing' },
];

describe('formatTranscriptForInjection', () => {
  it('attributes each agent line to the agent that said it', () => {
    const out = formatTranscriptForInjection(CONVERSATION, { agentNames: NAMES });
    expect(out).toBe(
      [
        'Caller: I need a refund on invoice 12',
        'Receptionist: Let me get billing for you.',
        'Billing Department: Hi, I can pull that invoice up.',
      ].join('\n'),
    );
  });

  it('interleaves completed transfers in chronological order, with their reason', () => {
    const out = formatTranscriptForInjection(CONVERSATION, {
      agentNames: NAMES,
      handoffs: [{ from: 'receptionist', to: 'billing', atMs: 3000, reason: 'refund request' }],
    });
    expect(out.split('\n')).toEqual([
      'Caller: I need a refund on invoice 12',
      'Receptionist: Let me get billing for you.',
      '[transfer] Receptionist -> Billing Department (reason: refund request)',
      'Billing Department: Hi, I can pull that invoice up.',
    ]);
  });

  it('keeps a transfer behind the line that triggered it when both share a timestamp', () => {
    const out = formatTranscriptForInjection(CONVERSATION, {
      agentNames: NAMES,
      handoffs: [{ from: 'receptionist', to: 'billing', atMs: 2000 }],
    });
    expect(out.split('\n')[1]).toBe('Receptionist: Let me get billing for you.');
    expect(out.split('\n')[2]).toBe('[transfer] Receptionist -> Billing Department');
  });

  it('falls back to the agent id, then a generic label, when no name is known', () => {
    const out = formatTranscriptForInjection(
      [
        { role: 'agent', text: 'known', timestampMs: 1, agentId: 'billing' },
        { role: 'agent', text: 'unmapped', timestampMs: 2, agentId: 'legal' },
        { role: 'agent', text: 'anonymous', timestampMs: 3 },
      ],
      { agentNames: NAMES },
    );
    expect(out.split('\n')).toEqual([
      'Billing Department: known',
      'legal: unmapped',
      'Agent: anonymous',
    ]);
  });

  it('trims to maxTurns and drops transfers older than the replayed window', () => {
    const entries: TranscriptEntry[] = Array.from({ length: 5 }, (_, i) => ({
      role: 'user',
      text: `turn ${i}`,
      timestampMs: i * 1000,
    }));
    const out = formatTranscriptForInjection(entries, {
      maxTurns: 2,
      handoffs: [
        { from: 'receptionist', to: 'billing', atMs: 500 }, // before the window
        { from: 'billing', to: 'receptionist', atMs: 3500 }, // inside it
      ],
    });
    expect(out.split('\n')).toEqual([
      'Caller: turn 3',
      '[transfer] billing -> receptionist',
      'Caller: turn 4',
    ]);
  });

  it('renders nothing for an empty transcript', () => {
    expect(formatTranscriptForInjection([], { handoffs: [{ from: 'a', to: 'b', atMs: 1 }] })).toBe('');
  });
});
