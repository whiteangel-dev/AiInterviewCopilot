import { describe, expect, it } from 'vitest';
import { buildSessionContext } from './context';
import {
  cleanAnswerText,
  formatHistory,
  liveAnswerInput,
  liveAnswerSystem,
  parseTurnVerdict,
  readTurnAction,
  turnAnalyzerInput,
} from './live';

const context = buildSessionContext({
  today: '2026-11-04',
  company: 'Kestrel Pay',
  role: 'Senior Backend Engineer',
  brief: 'Jordan Rivera, backend engineer.',
  knowledge: 'Answer instructions (follow these)\n- Keep salary answers to a range.',
}).text;

describe('live answer prompt', () => {
  it('puts the rules first and the session context last, unchanged', () => {
    const system = liveAnswerSystem({ length: 'standard', context });
    expect(system.startsWith('You are an interview copilot.')).toBe(true);
    expect(system.endsWith(context)).toBe(true);
    expect(system).toContain('GROUNDING');
    expect(system).toContain('2 to 4 bullets');
    expect(system).toContain('- Company: Kestrel Pay');
    // Byte-identical across calls, so the provider can cache it.
    expect(liveAnswerSystem({ length: 'standard', context })).toBe(system);
    expect(liveAnswerSystem({ length: 'short', context })).toContain('Then 2 bullets');
  });

  it('formats the interview so far, merging consecutive lines', () => {
    const history = formatHistory([
      { who: 'interviewer', text: 'Thanks for joining.' },
      { who: 'interviewer', text: 'How are you?' },
      { who: 'candidate', text: " I'm good, thanks. " },
      { who: 'candidate', text: '' },
    ]);
    expect(history).toBe(
      "Interviewer: Thanks for joining. How are you?\nCandidate: I'm good, thanks.",
    );
    expect(liveAnswerInput({ history, turn: 'Tell me about yourself.' })).toBe(
      `INTERVIEW SO FAR\n${history}\n\nINTERVIEWER'S LATEST TURN\nTell me about yourself.`,
    );
    expect(liveAnswerInput({ history: '', turn: 'Hi!' })).toContain('(start of interview)');
  });

  it('cleans labels and quotes the model sometimes adds', () => {
    expect(cleanAnswerText('Answer: "Sure, I can.\n* First\n• Second')).toBe(
      'Sure, I can.\n- First\n- Second',
    );
    expect(cleanAnswerText("I'm doing well.")).toBe("I'm doing well.");
  });
});

describe('turn analyzer', () => {
  it('reads the action from a partial stream', () => {
    expect(readTurnAction('{"complete": true, "confidence": 0.9, "act')).toBeNull();
    expect(readTurnAction('{"complete": true, "confidence": 0.9, "action": "answer", "ty')).toBe(
      'answer',
    );
    expect(readTurnAction('{"complete":false,"confidence":0.8,"action":"wait"')).toBe('wait');
  });

  it('parses a verdict leniently', () => {
    expect(
      parseTurnVerdict(
        '{"complete":true,"confidence":0.95,"action":"answer","type":"behavioral","isFollowUp":false,"standaloneQuestion":" Tell me about a conflict. "}',
      ),
    ).toEqual({
      complete: true,
      confidence: 0.95,
      action: 'answer',
      type: 'behavioral',
      isFollowUp: false,
      standaloneQuestion: 'Tell me about a conflict.',
    });
    // Cut off after the action.
    expect(parseTurnVerdict('{"complete":true,"confidence":0.9,"action":"ignore","ty')).toEqual({
      complete: true,
      confidence: 0.5,
      action: 'ignore',
      type: 'other',
      isFollowUp: false,
      standaloneQuestion: '',
    });
    expect(parseTurnVerdict('{"complete":tr')).toBeNull();
    expect(parseTurnVerdict('not json')).toBeNull();
  });

  it('adds the long-silence hint only when asked', () => {
    const input = turnAnalyzerInput({ recent: '', turn: 'So, um,', longSilence: false });
    expect(input).toBe('RECENT CONVERSATION\n(start of interview)\n\nCURRENT TURN SO FAR\nSo, um,');
    expect(
      turnAnalyzerInput({ recent: 'Interviewer: Hi.', turn: 'So', longSilence: true }),
    ).toMatch(/silent for over a second/);
  });
});
