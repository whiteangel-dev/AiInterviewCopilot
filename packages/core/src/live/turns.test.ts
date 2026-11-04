import { describe, expect, it } from 'vitest';
import {
  REPLY_NOT_TRANSCRIBED,
  TurnTaker,
  endsWithQuestion,
  type AnalyzeInput,
  type AnswerUpdate,
  type BankAnswer,
  type TurnAction,
  type TurnAnswer,
  type TurnTakerOptions,
  type TurnVerdict,
  type WriteInput,
  type WriteResult,
} from './turns';

interface Call<I, R> {
  input: I;
  signal: AbortSignal;
  resolve(value: R): void;
  reject(err: unknown): void;
}

const verdict = (action: TurnAction, standaloneQuestion = ''): TurnVerdict => ({
  complete: action !== 'wait',
  confidence: 0.9,
  action,
  type: action === 'answer' ? 'behavioral' : 'statement',
  isFollowUp: false,
  standaloneQuestion,
});

const usage: WriteResult = {
  model: 'flash-lite',
  inputTokens: 100,
  cachedTokens: 0,
  outputTokens: 20,
  firstTextMs: 400,
  durationMs: 800,
};

function harness(options: Partial<TurnTakerOptions> = {}) {
  let now = 10_000;
  let session = 0;
  const analyses: (Call<AnalyzeInput, TurnVerdict | null> & { onAction(a: TurnAction): void })[] =
    [];
  const writes: (Call<WriteInput, WriteResult> & { onText(t: string): void })[] = [];
  const updates: { answer: TurnAnswer; update: AnswerUpdate }[] = [];
  const phases: string[] = [];
  const tt = new TurnTaker({
    now: () => now,
    sessionMs: () => session,
    auto: true,
    length: 'standard',
    answerModel: 'flash-lite',
    analyze: (input, signal, onAction) =>
      new Promise((resolve, reject) => analyses.push({ input, signal, onAction, resolve, reject })),
    write: (input, signal, onText) =>
      new Promise((resolve, reject) => writes.push({ input, signal, onText, resolve, reject })),
    bank: () => null,
    onAnswer: (answer, update) => updates.push({ answer, update }),
    onPhase: (p) => phases.push(p),
    errorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    ...options,
  });
  let seg = 0;
  const h = {
    tt,
    analyses,
    writes,
    updates,
    phases,
    /** Advances both clocks, ticking every 100 ms like the live run. */
    advance(ms: number) {
      for (let left = ms; left > 0; left -= 100) {
        const step = Math.min(100, left);
        now += step;
        session += step;
        tt.tick();
      }
    },
    /** The interviewer talks for `ms` and stops; voice detection reports the pause 300 ms later. */
    say(ms: number) {
      tt.speech('interviewer', true);
      const startMs = Math.max(0, session - 60);
      h.advance(ms + 300);
      tt.speech('interviewer', false);
      return startMs;
    },
    final(who: 'interviewer' | 'candidate', text: string, startMs: number) {
      tt.final(who, { id: `s${++seg}`, text, startMs });
    },
    interim(text: string, startMs: number) {
      tt.interim('interviewer', { id: 'interim', text, startMs });
    },
    shown: () => updates.filter((u) => u.update.shown).map((u) => u.answer),
    last: () => updates.at(-1)?.answer,
  };
  return h;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('turn taking', () => {
  it('re-runs the attempt as the transcript catches up, and shows the answer the analyzer confirms', async () => {
    const h = harness();
    const start = h.say(1600);
    h.interim('Tell me about', start);
    // The pause started an attempt on the partial text.
    expect(h.analyses).toHaveLength(1);
    expect(h.analyses[0]!.input.turn).toBe('Tell me about');
    expect(h.writes).toHaveLength(1);

    h.advance(400);
    h.final('interviewer', 'Tell me about a time you failed.', start);
    // The fuller transcript cancels the first attempt and starts another.
    expect(h.analyses[0]!.signal.aborted).toBe(true);
    expect(h.writes[0]!.signal.aborted).toBe(true);
    expect(h.analyses).toHaveLength(2);
    expect(h.analyses[1]!.input).toEqual({
      turn: 'Tell me about a time you failed.',
      history: [],
      longSilence: false,
    });

    // The speculative answer streams but stays hidden until confirmed.
    h.writes[1]!.onText('Sure.');
    expect(h.shown()).toHaveLength(0);
    h.advance(100);
    h.analyses[1]!.onAction('answer');
    const shown = h.shown();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      text: 'Sure.',
      status: 'streaming',
      source: 'generated',
      trigger: 'analyzer',
      heard: 'Tell me about a time you failed.',
      // Last word at the pause minus 300 ms; shown 800 ms later.
      latencyMs: 800,
      model: 'flash-lite',
    });

    h.writes[1]!.onText('Sure. The one that stands out was a migration.');
    h.analyses[1]!.resolve(verdict('answer', 'Tell me about a time you failed at work.'));
    h.writes[1]!.resolve(usage);
    await flush();
    const final = h.last()!;
    expect(final).toMatchObject({
      status: 'done',
      text: 'Sure. The one that stands out was a migration.',
      question: 'Tell me about a time you failed at work.',
      type: 'behavioral',
    });
    expect(h.updates.at(-1)!.update).toEqual({ final: true, shown: false, usage });
    expect(h.tt.stats).toMatchObject({ attempts: 2, cancelled: 1, answered: 1, withdrawn: 0 });
  });

  it('shows a turn ending in "?" at once, and withdraws it if the analyzer disagrees', async () => {
    const h = harness();
    const start = h.say(1200);
    h.final('interviewer', 'So how did that go?', start);
    h.writes[0]!.onText('It went well.');
    expect(h.shown()[0]).toMatchObject({ trigger: 'question-mark', text: 'It went well.' });

    h.analyses[0]!.onAction('wait');
    expect(h.writes[0]!.signal.aborted).toBe(true);
    expect(h.last()).toMatchObject({ status: 'withdrawn' });
    expect(h.updates.at(-1)!.update.final).toBe(true);
    expect(h.tt.answers()).toHaveLength(0);
    expect(h.tt.stats).toMatchObject({ answered: 0, withdrawn: 1 });

    // Still the same turn: more speech extends it.
    const more = h.say(1500);
    h.final('interviewer', 'I mean the migration.', more);
    expect(h.analyses.at(-1)!.input.turn).toBe('So how did that go? I mean the migration.');
    await flush();
  });

  it('cancels the attempt when the interviewer keeps talking, then answers the whole turn', () => {
    const h = harness();
    const a = h.say(1500);
    h.final('interviewer', 'So I see you were at Quayside for a while,', a);
    expect(h.analyses).toHaveLength(1);
    h.advance(300);
    const b = h.say(1800);
    expect(h.analyses[0]!.signal.aborted).toBe(true);
    h.final('interviewer', "and I'm curious how big the platform team was.", b);
    expect(h.analyses.at(-1)!.input.turn).toBe(
      "So I see you were at Quayside for a while, and I'm curious how big the platform team was.",
    );
    expect(h.tt.stats.cancelled).toBe(1);
  });

  it('asks again with a hint after 1.2 s of silence', () => {
    const h = harness();
    const a = h.say(1500);
    h.final('interviewer', 'Okay, last one from me', a);
    h.analyses[0]!.onAction('wait');
    expect(h.analyses).toHaveLength(1);
    h.advance(500);
    expect(h.analyses).toHaveLength(1);
    // 300 ms (pause) + 900 ms = 1.2 s of silence.
    h.advance(400);
    expect(h.analyses).toHaveLength(2);
    expect(h.analyses[1]!.input).toMatchObject({
      turn: 'Okay, last one from me',
      longSilence: true,
    });
    h.writes[1]!.onText('Sure.');
    h.analyses[1]!.onAction('answer');
    expect(h.shown()[0]).toMatchObject({ trigger: 'fallback' });
    // Only once per pause.
    h.advance(3000);
    expect(h.analyses).toHaveLength(2);
  });

  it('starts a new turn after an answer, with the earlier lines as history', () => {
    const h = harness();
    const a = h.say(1500);
    h.final('interviewer', "How's your day going?", a);
    h.writes[0]!.onText("It's good, thanks.");
    expect(h.shown()).toHaveLength(1);

    h.tt.speech('candidate', true);
    h.advance(1200);
    h.tt.speech('candidate', false);
    h.final('candidate', "It's going well, thanks for asking.", a + 2000);
    h.advance(500);

    const b = h.say(2000);
    h.final('interviewer', 'Tell me about yourself.', b);
    const input = h.analyses.at(-1)!.input;
    expect(input.turn).toBe('Tell me about yourself.');
    expect(input.history).toEqual([
      { who: 'interviewer', text: "How's your day going?" },
      { who: 'candidate', text: "It's going well, thanks for asking." },
    ]);
  });

  it('marks an answered question whose reply was not transcribed', () => {
    const h = harness();
    const a = h.say(1500);
    h.final('interviewer', "How's your day going?", a);
    h.writes[0]!.onText('Good, thanks.');
    h.advance(3000);
    const b = h.say(1500);
    h.final('interviewer', 'Tell me about yourself.', b);
    expect(h.analyses.at(-1)!.input.history).toEqual([
      { who: 'interviewer', text: "How's your day going?" },
      { who: 'candidate', text: REPLY_NOT_TRANSCRIBED },
    ]);
    // Not once the analyzer withdrew the answer: then it wasn't answered.
    const g = harness();
    const c = g.say(1500);
    g.final('interviewer', 'And?', c);
    g.writes[0]!.onText('Sure.');
    g.analyses[0]!.onAction('wait');
    const d = g.say(1500);
    g.final('interviewer', 'What do you think?', d);
    expect(g.analyses.at(-1)!.input).toMatchObject({
      turn: 'And? What do you think?',
      history: [],
    });
  });

  it('keeps a statement and the question after it in one turn, unless the candidate replied', () => {
    const h = harness();
    const a = h.say(2000);
    h.final('interviewer', 'So we mostly use Go here.', a);
    h.analyses[0]!.onAction('ignore');
    h.advance(400);
    const b = h.say(1500);
    h.final('interviewer', 'Have you used it?', b);
    expect(h.analyses.at(-1)!.input.turn).toBe('So we mostly use Go here. Have you used it?');

    // A reply from the candidate ends the interviewer's turn.
    const g = harness();
    const c = g.say(2000);
    g.final('interviewer', 'So we mostly use Go here.', c);
    g.analyses[0]!.onAction('ignore');
    g.tt.speech('candidate', true);
    g.advance(1100);
    g.tt.speech('candidate', false);
    const d = g.say(1500);
    g.final('interviewer', 'Have you used it?', d);
    expect(g.analyses.at(-1)!.input.turn).toBe('Have you used it?');
    expect(g.tt.stats.ignored).toBe(1);
  });

  it('shows an approved answer-bank answer without writing one', () => {
    const bankAnswer: BankAnswer = {
      preparedAnswerId: 'p1',
      question: 'Tell me about yourself.',
      text: "I'm a backend engineer.\n- Six years.",
    };
    const h = harness({ bank: (heard) => (/yourself/.test(heard) ? bankAnswer : null) });
    const a = h.say(1500);
    h.final('interviewer', 'To start, tell me about yourself.', a);
    expect(h.writes).toHaveLength(0);
    h.analyses[0]!.onAction('answer');
    expect(h.shown()[0]).toMatchObject({
      source: 'bank',
      preparedAnswerId: 'p1',
      text: bankAnswer.text,
      status: 'done',
      model: null,
    });
    expect(h.updates[0]!.update).toMatchObject({ shown: true, final: true });
  });

  it('answers on request when automatic answers are off', () => {
    const h = harness({ auto: false });
    const a = h.say(1500);
    h.final('interviewer', 'Tell me about a project you led.', a);
    h.advance(2000);
    expect(h.analyses).toHaveLength(0);
    expect(h.writes).toHaveLength(0);

    expect(h.tt.answerNow()).toBe(true);
    expect(h.analyses).toHaveLength(0);
    h.writes[0]!.onText('Sure.');
    expect(h.shown()[0]).toMatchObject({ trigger: 'manual', latencyMs: null });
  });

  it('"Answer now" confirms the attempt already in flight', () => {
    const h = harness();
    const a = h.say(1500);
    h.final('interviewer', 'Walk me through your last project', a);
    h.writes[0]!.onText('Sure.');
    expect(h.shown()).toHaveLength(0);
    h.tt.answerNow();
    expect(h.writes).toHaveLength(1);
    expect(h.shown()[0]).toMatchObject({ trigger: 'manual', text: 'Sure.' });
  });

  it('regenerates the last answer at another length, keeping the question', async () => {
    const h = harness();
    const a = h.say(1500);
    h.final('interviewer', 'Why do you want this job?', a);
    h.writes[0]!.onText('Because.');
    h.writes[0]!.resolve(usage);
    await flush();
    const first = h.shown()[0]!;

    expect(h.tt.regenerate(null, 'short')).toBe(true);
    expect(h.writes[1]!.input).toEqual({
      turn: 'Why do you want this job?',
      history: [],
      length: 'short',
    });
    h.writes[1]!.onText('Short version.');
    const second = h.shown()[1]!;
    expect(second).toMatchObject({
      questionId: first.questionId,
      trigger: 'regenerate',
      length: 'short',
      latencyMs: null,
    });
    expect(second.id).not.toBe(first.id);

    // "Answer now" with nothing new also writes a fresh answer to the last question.
    h.tt.answerNow();
    expect(h.writes[1]!.signal.aborted).toBe(true);
    expect(
      h.updates.find((u) => u.answer.id === second.id && u.answer.status === 'stopped'),
    ).toBeTruthy();
    expect(h.writes).toHaveLength(3);
    expect(h.tt.stats.answered).toBe(1);
  });

  it('shows an error when the answer fails after the question was confirmed', async () => {
    const h = harness();
    const a = h.say(1500);
    h.final('interviewer', 'What are your strengths?', a);
    h.writes[0]!.reject(new Error("Couldn't reach Google."));
    await flush();
    expect(h.shown()[0]).toMatchObject({
      status: 'error',
      error: "Couldn't reach Google.",
      text: '',
    });
  });

  it('starts a new turn after a pause, and stops streaming answers at the end', () => {
    const h = harness();
    const a = h.say(1500);
    h.final('interviewer', 'So, um,', a);
    h.tt.pause();
    expect(h.analyses[0]!.signal.aborted).toBe(true);
    // Words flushed while pausing are kept, but start nothing.
    h.final('interviewer', 'anyway.', a + 1500);
    expect(h.analyses).toHaveLength(1);
    h.tt.resume();
    const b = h.say(1500);
    h.final('interviewer', 'What do you know about us?', b);
    expect(h.analyses.at(-1)!.input).toMatchObject({
      turn: 'What do you know about us?',
      history: [
        { who: 'interviewer', text: 'So, um,' },
        { who: 'interviewer', text: 'anyway.' },
      ],
    });
    h.writes.at(-1)!.onText('A little.');
    expect(h.last()!.status).toBe('streaming');
    h.tt.stop();
    expect(h.writes.at(-1)!.signal.aborted).toBe(true);
    expect(h.last()!.status).toBe('stopped');
    expect(h.tt.answerNow()).toBe(false);
  });

  it('still answers when voice detection misses the speech', () => {
    const h = harness();
    h.advance(2000);
    h.final('interviewer', 'Can you hear me okay?', 1000);
    expect(h.analyses).toHaveLength(1);
    h.writes[0]!.onText('Yes, I can.');
    expect(h.shown()[0]).toMatchObject({ latencyMs: 700, trigger: 'question-mark' });
  });

  it('reports what it is doing', () => {
    const h = harness();
    const a = h.say(1000);
    h.final('interviewer', 'Tell me more', a);
    h.analyses[0]!.onAction('wait');
    expect(h.phases).toEqual(['listening', 'idle', 'thinking', 'idle']);
  });
});

describe('endsWithQuestion', () => {
  it('detects a turn that ends with a question mark', () => {
    expect(endsWithQuestion('How are you?')).toBe(true);
    expect(endsWithQuestion('How are you? ')).toBe(true);
    expect(endsWithQuestion('You said "why?"')).toBe(true);
    expect(endsWithQuestion('How are you? So, tell me')).toBe(false);
    expect(endsWithQuestion('Tell me about yourself.')).toBe(false);
  });
});
