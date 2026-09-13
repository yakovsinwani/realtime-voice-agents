import { describe, expect, it } from 'vitest';
import { buildHistoryItems, buildSessionStart, GPT_LIVE_DEFAULT_BACKEND_MODEL } from './session-config.js';

const TOOL = { name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: {} } };

describe('GPT-Live session.start builder', () => {
  it('puts the voice prompt on the session and the tools on the backend delegation, μ-law 8 kHz both ways', () => {
    const { frame } = buildSessionStart(
      { instructions: 'Voice prompt.', voice: 'cedar', tools: [TOOL] },
      { delegation: { instructions: 'Backend prompt.', reasoning: { effort: 'low' } } },
      'start_1',
      'gpt-live-1',
    );
    expect(frame.type).toBe('session.start');
    expect(frame.event_id).toBe('start_1');
    const session = frame.session as any;
    expect(session.model).toBe('gpt-live-1');
    expect(session.instructions).toBe('Voice prompt.');
    expect(session.audio).toEqual({ format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'cedar' } });
    expect(session.delegation.type).toBe('responses');
    expect(session.delegation.responses.model).toBe(GPT_LIVE_DEFAULT_BACKEND_MODEL);
    expect(session.delegation.responses.instructions).toBe('Backend prompt.');
    expect(session.delegation.responses.reasoning).toEqual({ effort: 'low' });
    expect(session.delegation.responses.tools).toEqual([
      { type: 'function', name: 'lookup', description: 'Look something up', parameters: TOOL.parameters },
    ]);
    expect(session.delegation.responses.tool_choice).toBe('auto');
    // Nothing the voice model does not accept: no turn detection, no
    // transcription config, no top-level tools, no speed.
    expect(session.tools).toBeUndefined();
    expect(JSON.stringify(session)).not.toMatch(/turn_detection|transcription|"speed"/);
    expect(session.input).toBeUndefined();
    expect(session.store).toBeUndefined();
  });

  it('the factory default voice applies only when the agent sets none', () => {
    const withDefault = buildSessionStart({ instructions: 'x' }, { defaultVoice: 'marin' }, 'e', 'gpt-live-1').frame
      .session as any;
    expect(withDefault.audio.output.voice).toBe('marin');
    const agentVoice = buildSessionStart({ instructions: 'x', voice: 'sage' }, { defaultVoice: 'marin' }, 'e', 'gpt-live-1')
      .frame.session as any;
    expect(agentVoice.audio.output.voice).toBe('sage');
  });

  it('seeds history as text messages (developer/user/assistant), store when asked', () => {
    const { frame } = buildSessionStart(
      {
        instructions: 'x',
        history: [
          { role: 'developer', text: 'Context note.' },
          { role: 'user', text: 'Hi' },
          { role: 'assistant', text: 'Hello, how can I help?' },
        ],
      },
      { store: true },
      'e',
      'gpt-live-1',
    );
    const session = frame.session as any;
    expect(session.store).toBe(true);
    expect(session.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Context note.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello, how can I help?' }] },
    ]);
  });

  it('trims history newest-first within the API bounds, pinning the leading developer note', () => {
    const history = [
      { role: 'developer' as const, text: 'PIN' },
      ...Array.from({ length: 200 }, (_, i) => ({ role: 'user' as const, text: `turn ${i}` })),
    ];
    const byCount = buildHistoryItems(history, { maxMessages: 10 });
    expect(byCount.items).toHaveLength(10);
    expect((byCount.items[0] as any).content[0].text).toBe('PIN');
    expect((byCount.items[9] as any).content[0].text).toBe('turn 199');
    expect(byCount.dropped).toBe(191);

    const byChars = buildHistoryItems(history, { maxChars: 30 });
    expect((byChars.items[0] as any).content[0].text).toBe('PIN');
    expect(byChars.items.length).toBeLessThan(6);
    expect((byChars.items.at(-1) as any).content[0].text).toBe('turn 199');
  });

  it('providerOptions and extraSessionOptions deep-merge last (strict schema escape hatch)', () => {
    const { frame } = buildSessionStart(
      { instructions: 'x', providerOptions: { delegation: { responses: { model: 'gpt-5.6-luna' } } } },
      { extraSessionOptions: { audio: { output: { voice: 'cedar' } } } },
      'e',
      'gpt-live-1',
    );
    const session = frame.session as any;
    expect(session.delegation.responses.model).toBe('gpt-5.6-luna');
    expect(session.delegation.type).toBe('responses');
    expect(session.audio.output.voice).toBe('cedar');
    expect(session.audio.format).toEqual({ type: 'audio/pcmu', rate: 8000 });
  });
});
