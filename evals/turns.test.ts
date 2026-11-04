/**
 * Turn analyzer evaluation (Phase 4): the production prompt and parser
 * (@aic/prompts) through the production provider (@aic/core), on the Phase 0
 * probes:
 * - 17 complete interviewer turns: is the action right (answer vs ignore)?
 * - 16 turns split at mid-sentence pauses: does it wait at the pauses, and
 *   answer at the real end?
 *
 * Phase 0 (spike prompt): action right at 97% of turn ends; answered too early
 * at 19% of mid-turn pauses (all genuinely ambiguous); decision p50 606 ms.
 * About 50 small requests.
 */
import { GeminiProvider } from '@aic/core';
import { DEFAULT_MODELS } from '@aic/ipc';
import {
  TURN_ANALYZER_SYSTEM,
  TURN_VERDICT_SCHEMA,
  formatHistory,
  parseTurnVerdict,
  readTurnAction,
  turnAnalyzerInput,
  type TurnVerdict,
} from '@aic/prompts';
import { describe, expect, it } from 'vitest';
import { API_KEY, loadQuestions, loadTurns, ms, percentile, report, saveResult } from './lib';

interface Probe {
  id: string;
  transcript: string;
  recent: string;
  /** At the real end of the turn; otherwise at a mid-turn pause. */
  isEnd: boolean;
  expect: 'answer' | 'ignore' | 'wait';
  followUp: boolean;
}

function probes(): Probe[] {
  const out: Probe[] = [];
  const questions = loadQuestions();
  for (const q of questions) {
    const parent = q.parent ? questions.find((x) => x.id === q.parent) : undefined;
    out.push({
      id: q.id,
      transcript: q.text,
      recent: parent
        ? formatHistory([
            { who: 'interviewer', text: parent.text },
            { who: 'candidate', text: parent.candidateSaid ?? '' },
          ])
        : '',
      isEnd: true,
      expect: q.kind === 'skip' ? 'ignore' : 'answer',
      followUp: Boolean(q.parent),
    });
  }
  for (const t of loadTurns()) {
    const recent = t.context
      ? formatHistory([
          { who: 'interviewer', text: t.context.question },
          { who: 'candidate', text: t.context.candidateSaid },
        ])
      : '';
    t.phrases.forEach((_, i) => {
      const isEnd = i === t.phrases.length - 1;
      out.push({
        id: `${t.id}.${i + 1}`,
        transcript: t.phrases.slice(0, i + 1).join(' '),
        recent,
        isEnd,
        expect: isEnd ? t.final : 'wait',
        followUp: isEnd && Boolean(t.context),
      });
    });
  }
  return out;
}

describe.skipIf(!API_KEY)('turn analyzer (real Gemini)', () => {
  it('decides answer / ignore / wait like Phase 0', async () => {
    const provider = new GeminiProvider();
    const model = process.env.AIC_EVAL_ANALYZER_MODEL ?? DEFAULT_MODELS.turnAnalyzer;
    await provider.warmUp(API_KEY!, model);
    const rows: (Probe & { verdict: TurnVerdict | null; decisionMs: number; totalMs: number })[] =
      [];
    for (const p of probes()) {
      const started = performance.now();
      let decisionMs = Number.NaN;
      let json = '';
      const res = await provider.streamText({
        apiKey: API_KEY!,
        model,
        system: TURN_ANALYZER_SYSTEM,
        text: turnAnalyzerInput({ recent: p.recent, turn: p.transcript, longSilence: false }),
        schema: TURN_VERDICT_SCHEMA,
        thinking: 'minimal',
        maxOutputTokens: 300,
        task: 'turn-analyzer',
        onText: (piece) => {
          json += piece;
          if (Number.isNaN(decisionMs) && readTurnAction(json)) {
            decisionMs = performance.now() - started;
          }
        },
      });
      rows.push({
        ...p,
        verdict: parseTurnVerdict(res.text),
        decisionMs,
        totalMs: performance.now() - started,
      });
    }

    // What matters in the app: an answer shown at a mid-turn pause (too early),
    // and a question that gets no answer. "wait" and "ignore" both show nothing.
    const shows = (r: (typeof rows)[number]) => r.verdict?.action === 'answer';
    const questions = rows.filter((r) => r.isEnd && r.expect === 'answer');
    const nonQuestions = rows.filter((r) => r.isEnd && r.expect !== 'answer');
    const pauses = rows.filter((r) => !r.isEnd);
    const answered = questions.filter(shows).length;
    const quiet = nonQuestions.filter((r) => !shows(r)).length;
    const early = pauses.filter(shows).length;
    const exactWait = pauses.filter((r) => r.verdict?.action === 'wait').length;
    const followRight = questions.filter((r) => r.verdict?.isFollowUp === r.followUp).length;
    const decision = rows.map((r) => r.decisionMs);
    report([
      '',
      `Turn analyzer: ${model}, ${rows.length} probes`,
      ...rows
        .filter((r) => r.verdict?.action !== r.expect)
        .map(
          (r) =>
            `  ${shows(r) !== (r.expect === 'answer') ? '✗' : '~'} ${r.id} expected ${r.expect}, got ${r.verdict?.action ?? 'nothing'}: "${r.transcript}"`,
        ),
      `  questions answered at the end of the turn: ${answered}/${questions.length}`,
      `  no answer for statements and filler: ${quiet}/${nonQuestions.length}`,
      `  answered too early, at a mid-turn pause: ${early}/${pauses.length} (exactly "wait": ${exactWait})`,
      `  follow-up flag right: ${followRight}/${questions.length}`,
      `  decision p50 ${ms(percentile(decision, 50))} · p95 ${ms(percentile(decision, 95))}`,
      `  saved ${saveResult('turns', { model, rows })}`,
    ]);

    // Phase 0: 97% of turn ends right; 19% early at mid-turn pauses (all genuinely ambiguous).
    expect(answered / questions.length).toBeGreaterThanOrEqual(0.9);
    expect(quiet).toBe(nonQuestions.length);
    expect(early / pauses.length).toBeLessThanOrEqual(0.3);
    expect(percentile(decision, 50)).toBeLessThan(1200);
  }, 180_000);
});
