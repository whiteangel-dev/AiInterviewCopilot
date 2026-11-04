import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveAnswer } from '@aic/ipc';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, dirs, setup, speechWav, until } from './test-helpers';

afterEach(cleanup);

function latest(answers: LiveAnswer[]): LiveAnswer[] {
  const byId = new Map<string, LiveAnswer>();
  for (const a of answers) byId.set(a.id, a);
  return [...byId.values()];
}

describe('hardening (recorded audio, fake transcription and model)', () => {
  it('fact-checks answers, counts usage and estimates the cost', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aic-wav-'));
    dirs.push(tmp);
    const { h, of } = await setup({
      interviewer: speechWav(tmp, 'interviewer.wav', [
        [300, 1400],
        [2600, 1600],
      ]),
      candidate: speechWav(tmp, 'candidate.wav', [[2100, 1300]]),
    });
    const started = await h['live.start']({
      mode: 'interview',
      title: '',
      profileId: null,
      knowledgeBaseId: null,
      transcribe: true,
    });

    // The fake checker flags the "small squad" line of the second answer.
    const checked = () =>
      latest(of('live.answer')).filter(
        (a) => a.check && a.check.status !== 'checking' && a.status === 'done',
      );
    await until(() => checked().length >= 2, 15_000);
    const [first, second] = checked();
    expect(first!.check).toMatchObject({ status: 'ok', issues: [] });
    expect(second!.check).toMatchObject({
      status: 'issues',
      issues: [
        {
          quote: "Lately I've led a small squad",
          problem: "Your profile doesn't say you led a squad.",
        },
      ],
      model: 'gemini-3.5-flash-lite',
    });
    // "Checking…" was shown first.
    expect(of('live.answer').some((a) => a.check?.status === 'checking')).toBe(true);
    // A window opened now sees the check too.
    expect((await h['live.answers']()).map((a) => a.check?.status)).toEqual(['ok', 'issues']);

    await h['live.stop']();
    const detail = await h['sessions.get']({ id: started.id });
    expect(detail.answers.map((a) => a.check?.status)).toEqual(['ok', 'issues']);

    // Every request was counted: analyzer, answers and fact checks.
    const usage = detail.stats!.usage!;
    expect(usage.transcriptionModel).toBe('gemini-3.5-transcribe-live');
    const lite = usage.models['gemini-3.5-flash-lite']!;
    expect(lite.requests).toBeGreaterThanOrEqual(6);
    expect(lite.inputTokens + lite.estimatedInputTokens).toBeGreaterThan(1000);
    expect(lite.outputTokens).toBeGreaterThan(10);
    expect(detail.cost).toMatchObject({ pricesChecked: '2026-11-04', unpriced: [] });
    expect(detail.cost!.transcriptionUsd).toBeGreaterThan(0);
    expect(detail.cost!.modelsUsd).toBeGreaterThan(0);
    expect(detail.cost!.totalUsd).toBeCloseTo(
      detail.cost!.transcriptionUsd! + detail.cost!.modelsUsd,
      6,
    );
  }, 30_000);

  it('skips the fact check when it is turned off', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aic-wav-'));
    dirs.push(tmp);
    const { h, of } = await setup({
      interviewer: speechWav(tmp, 'i.wav', [[200, 1400]]),
      candidate: null,
    });
    await h['settings.update']({ answers: { factCheck: false } });
    await h['live.start']({
      mode: 'interview',
      title: '',
      profileId: null,
      knowledgeBaseId: null,
      transcribe: true,
    });
    await until(() => latest(of('live.answer')).some((a) => a.status === 'done'));
    await new Promise((r) => setTimeout(r, 300));
    expect(of('live.answer').every((a) => a.check === null)).toBe(true);
    await h['live.stop']();
  }, 15_000);
});
