import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveAnswer } from '@aic/ipc';
import { afterEach, describe, expect, it } from 'vitest';
import { call, cleanup, dirs, setup, speechWav, until } from './test-helpers';

afterEach(cleanup);

/** The newest version of each answer (answers are re-sent as they stream). */
function latest(answers: LiveAnswer[]): LiveAnswer[] {
  const byId = new Map<string, LiveAnswer>();
  for (const a of answers) byId.set(a.id, a);
  return [...byId.values()];
}

describe('live answers (recorded audio, fake transcription and model)', () => {
  it('detects questions, streams answers, regenerates on request, and saves them', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aic-wav-'));
    dirs.push(tmp);
    // Three interviewer turns; the candidate replies after the first two.
    const interviewer = speechWav(tmp, 'interviewer.wav', [
      [300, 1400],
      [2600, 1600],
      [2600, 1200],
    ]);
    const candidate = speechWav(tmp, 'candidate.wav', [
      [2100, 1300],
      [2900, 1500],
    ]);
    const { h, of } = await setup({ interviewer, candidate });

    const started = await h['live.start']({
      mode: 'interview',
      title: '',
      profileId: null,
      knowledgeBaseId: null,
      transcribe: true,
      company: 'Kestrel Pay',
      role: 'Senior Backend Engineer',
    });
    expect(started.title).toBe('Kestrel Pay · Senior Backend Engineer');

    const done = () => latest(of('live.answer')).filter((a) => a.status === 'done');
    await until(() => done().length >= 3, 15_000);
    const answers = done();
    expect(answers.map((a) => a.heard)).toEqual([
      "Hi, thanks for joining us today. How's your day going so far?",
      'To get started, can you tell me a little bit about yourself?',
      'Why are you interested in this role?',
    ]);
    for (const a of answers) {
      expect(a).toMatchObject({
        runId: started.id,
        source: 'generated',
        trigger: 'question-mark',
        length: 'standard',
        model: 'gemini-3.5-flash-lite',
      });
      // Measured from the interviewer's last word; the fake model answers in ~50 ms.
      expect(a.latencyMs).toBeGreaterThan(200);
      expect(a.latencyMs).toBeLessThan(2500);
    }
    expect(answers[1]!.text).toMatch(/^Sure\. I'm a backend engineer/);
    // The answer streamed in pieces before it was done.
    const updates = of('live.answer').filter((a) => a.id === answers[1]!.id);
    expect(updates.some((a) => a.status === 'streaming')).toBe(true);
    expect(of('live.turn').some((t) => t.phase === 'thinking')).toBe(true);

    // A window opened mid-interview gets the answers so far.
    expect((await h['live.answers']()).map((a) => a.id)).toEqual(answers.map((a) => a.id));

    // "Shorter": a new answer to the same question.
    await h['live.regenerate']({ answerId: answers[1]!.id, length: 'short' });
    const regenerated = await until(() =>
      latest(of('live.answer')).find((a) => a.trigger === 'regenerate' && a.status === 'done'),
    );
    expect(regenerated).toMatchObject({
      questionId: answers[1]!.questionId,
      length: 'short',
      latencyMs: null,
    });
    await expect(
      call(() => h['live.regenerate']({ answerId: 'gone', length: null })),
    ).rejects.toMatchObject({ code: 'not_found' });

    await h['live.stop']();
    await expect(call(() => h['live.answerNow']())).rejects.toThrow(/Start an interview/);

    const detail = await h['sessions.get']({ id: started.id });
    expect(detail.answers.map((a) => [a.heard, a.trigger])).toEqual([
      ["Hi, thanks for joining us today. How's your day going so far?", 'question-mark'],
      ['To get started, can you tell me a little bit about yourself?', 'question-mark'],
      ['Why are you interested in this role?', 'question-mark'],
      ['To get started, can you tell me a little bit about yourself?', 'regenerate'],
    ]);
    expect(detail.answers[1]!.question).toBe(
      'To get started, can you tell me a little bit about yourself?',
    );
    expect(detail.answerCount).toBe(4);
    expect(detail.stats?.turns).toMatchObject({ answered: 3, withdrawn: 0 });
    expect((await h['sessions.list']())[0]!.answerCount).toBe(4);

    const md = await h['sessions.export']({
      id: started.id,
      format: 'markdown',
      includeAnswers: true,
    });
    expect(md.text).toContain('> **Suggested answer**\n> Sure.');
  }, 30_000);

  it('answers only on request when automatic answers are off', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aic-wav-'));
    dirs.push(tmp);
    const { h, of } = await setup({
      interviewer: speechWav(tmp, 'i.wav', [[200, 1400]]),
      candidate: null,
    });
    await h['settings.update']({ answers: { autoAnswer: false } });
    await h['live.start']({
      mode: 'interview',
      title: '',
      profileId: null,
      knowledgeBaseId: null,
      transcribe: true,
    });
    await expect(call(() => h['live.answerNow']())).rejects.toThrow(/nothing to answer/);
    await until(() => of('live.transcript').some((u) => u.kind === 'final'));
    await new Promise((r) => setTimeout(r, 600));
    expect(of('live.answer')).toEqual([]);

    await h['live.answerNow']();
    const answer = await until(() => latest(of('live.answer')).find((a) => a.status === 'done'));
    expect(answer).toMatchObject({ trigger: 'manual', latencyMs: null });
    await h['live.stop']();
  }, 15_000);

  it('does not answer during an audio test', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aic-wav-'));
    dirs.push(tmp);
    const { h, of } = await setup({
      interviewer: speechWav(tmp, 'i.wav', [[200, 1400]]),
      candidate: null,
    });
    await h['live.start']({
      mode: 'test',
      title: '',
      profileId: null,
      knowledgeBaseId: null,
      transcribe: true,
    });
    await until(() => of('live.transcript').some((u) => u.kind === 'final'));
    await new Promise((r) => setTimeout(r, 500));
    expect(of('live.answer')).toEqual([]);
    expect(await h['live.answers']()).toEqual([]);
    await h['live.stop']();
  }, 15_000);
});
