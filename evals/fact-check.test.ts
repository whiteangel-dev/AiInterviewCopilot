/**
 * Fact check evaluation (Phase 5): 26 answers for the fixture candidate,
 * 13 strictly grounded in the profile and notes, 13 with one planted claim
 * the sources don't support (wrong number, wrong employer, invented tool or
 * award, denied experience). Measures, per checker model:
 * - planted claims caught (an issue quoting the planted words);
 * - false alarms on grounded answers;
 * - time to the result (the check runs after the answer is shown).
 *
 * AIC_EVAL_FACT_VARIANTS="model:thinking,…" picks what to compare.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GeminiProvider } from '@aic/core';
import {
  FACT_CHECK_SCHEMA,
  FACT_CHECK_SYSTEM,
  factCheckInput,
  findQuote,
  parseFactCheck,
  type FactIssue,
} from '@aic/prompts';
import { describe, expect, it } from 'vitest';
import { API_KEY, fixtureContext, ms, percentile, report, saveResult } from './lib';

interface Case {
  id: string;
  question: string;
  answer: string;
  /** The planted unsupported words; null for a grounded answer. */
  injected: string | null;
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/fact-check.json'), 'utf8'),
) as Case[];

const VARIANTS = (
  process.env.AIC_EVAL_FACT_VARIANTS ??
  'gemini-3.5-flash-lite:minimal,gemini-3.5-flash-lite:low,gemini-3.8-flash:minimal'
)
  .split(',')
  .map((v): { model: string; thinking: 'low' | 'minimal' } => {
    const [model, thinking] = v.split(':');
    return { model: model!, thinking: thinking === 'low' ? 'low' : 'minimal' };
  });

const overlaps = (answer: string, a: string, b: string) => {
  const x = findQuote(answer, a);
  const y = findQuote(answer, b);
  return !!x && !!y && x[0] < y[1] && y[0] < x[1];
};

describe.skipIf(!API_KEY)('fact check (real Gemini)', () => {
  it('catches planted claims without flagging grounded answers', async () => {
    const provider = new GeminiProvider();
    const context = fixtureContext();
    const summary: Record<string, unknown>[] = [];
    for (const { model, thinking } of VARIANTS) {
      const rows: (Case & { issues: FactIssue[] | null; ms: number })[] = [];
      for (const c of CASES) {
        const started = performance.now();
        const res = await provider.streamText({
          apiKey: API_KEY!,
          model,
          system: FACT_CHECK_SYSTEM,
          text: factCheckInput({ context, question: c.question, answer: c.answer }),
          schema: FACT_CHECK_SCHEMA,
          thinking,
          maxOutputTokens: 2048,
          task: 'fact-check',
        });
        rows.push({
          ...c,
          issues: parseFactCheck(res.text, c.answer),
          ms: performance.now() - started,
        });
      }
      const planted = rows.filter((r) => r.injected);
      const clean = rows.filter((r) => !r.injected);
      const caught = planted.filter((r) =>
        r.issues?.some((i) => overlaps(r.answer, i.quote, r.injected!)),
      );
      const alarms = clean.filter((r) => (r.issues?.length ?? 1) > 0);
      const extra = planted.reduce(
        (n, r) =>
          n + (r.issues?.filter((i) => !overlaps(r.answer, i.quote, r.injected!)).length ?? 0),
        0,
      );
      const times = rows.map((r) => r.ms);
      const line = {
        model,
        thinking,
        caught: `${caught.length}/${planted.length}`,
        falseAlarms: `${alarms.length}/${clean.length}`,
        extraIssuesOnPlanted: extra,
        p50: Math.round(percentile(times, 50)),
        p95: Math.round(percentile(times, 95)),
      };
      summary.push(line);
      report([
        '',
        `${model} (${thinking} thinking): caught ${line.caught}, false alarms ${line.falseAlarms}, extra issues ${extra}, time p50 ${ms(line.p50)} · p95 ${ms(line.p95)}`,
        ...planted
          .filter((r) => !caught.includes(r))
          .map(
            (r) =>
              `  missed ${r.id}: "${r.injected}" → ${JSON.stringify(r.issues?.map((i) => i.quote))}`,
          ),
        ...alarms.map(
          (r) =>
            `  false alarm ${r.id}: ${r.issues?.map((i) => `"${i.quote}" (${i.problem})`).join('; ') ?? 'unparseable'}`,
        ),
      ]);
      saveResult(`fact-check-${model}-${thinking}`, { model, thinking, rows });
    }
    report(['', JSON.stringify(summary, null, 2)]);
    expect(summary.length).toBe(VARIANTS.length);
  }, 600_000);
});
