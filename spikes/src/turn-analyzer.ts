/**
 * Phase 0 — turn/question analyzer benchmark.
 *
 * One fast LLM call, made when the interviewer pauses, decides:
 *   complete? → action (answer | ignore | wait) → type → follow-up? → standalone rewrite.
 * `complete` is the first JSON field, so the decision can be read from the stream
 * before the rest of the JSON arrives ("decision" latency vs "full" latency).
 *
 * Datasets:
 *   - questions.json: 17 complete interviewer turns (action / follow-up accuracy)
 *   - turns.json: turns split at mid-sentence pauses (premature-trigger rate)
 * Then simulates end-of-turn policies (silence-only vs. silence + analyzer).
 *
 * Usage: npm run bench:turns -- [--models a,b] [--runs 2]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ThinkingLevel } from '@google/genai';
import type { GenerateContentConfig, ThinkingConfig } from '@google/genai';
import { createClient, errorMessage, parseArgs, sleep } from './lib/env.ts';
import { fmtMs, percentile, table } from './lib/stats.ts';
import { loadQuestions } from './prompt.ts';
import { ANALYZER_SCHEMA, ANALYZER_SYSTEM, analyzerUserText } from './analyzer.ts';
import type { Verdict } from './analyzer.ts';

interface Turn {
  id: string;
  phrases: string[];
  pausesMs: number[];
  final: 'answer' | 'ignore';
  context?: { question: string; candidateSaid: string };
}
interface Probe {
  dataset: 'questions' | 'turns';
  id: string;
  boundary: number; // index of the phrase after which the interviewer paused
  isEnd: boolean;
  pauseMs: number; // Infinity at the real end of the turn
  transcript: string;
  context?: { question: string; candidateSaid?: string };
  expectAction?: 'answer' | 'ignore';
  expectFollowUp?: boolean;
}

const args = parseArgs();
const runs = Number(args.get('runs') ?? 2);
const models = (args.get('models') ?? 'gemini-3.5-flash-lite').split(',').map((s) => s.trim());
const ai = createClient();

function buildProbes(): Probe[] {
  const probes: Probe[] = [];
  const questions = loadQuestions();
  for (const q of questions) {
    const parent = q.parent ? questions.find((x) => x.id === q.parent) : undefined;
    probes.push({
      dataset: 'questions', id: q.id, boundary: 0, isEnd: true, pauseMs: Number.POSITIVE_INFINITY, transcript: q.text,
      context: parent ? { question: parent.text, candidateSaid: parent.candidateSaid } : undefined,
      expectAction: q.kind === 'skip' ? 'ignore' : 'answer', expectFollowUp: Boolean(q.parent),
    });
  }
  const turns = JSON.parse(readFileSync(new URL('./fixtures/turns.json', import.meta.url), 'utf8')) as Turn[];
  for (const t of turns) {
    t.phrases.forEach((_, i) => {
      const isEnd = i === t.phrases.length - 1;
      probes.push({
        dataset: 'turns', id: t.id, boundary: i, isEnd,
        pauseMs: isEnd ? Number.POSITIVE_INFINITY : (t.pausesMs[i] ?? 0),
        transcript: t.phrases.slice(0, i + 1).join(' '), context: t.context,
        expectAction: isEnd ? t.final : undefined, expectFollowUp: isEnd ? Boolean(t.context) : undefined,
      });
    });
  }
  return probes;
}

function userText(p: Probe): string {
  return analyzerUserText(p.transcript, p.context);
}

async function resolveThinking(model: string): Promise<ThinkingConfig | undefined> {
  for (const tc of [{ thinkingBudget: 0 }, { thinkingLevel: ThinkingLevel.MINIMAL }, { thinkingLevel: ThinkingLevel.LOW }, undefined] as (ThinkingConfig | undefined)[]) {
    try {
      await ai.models.generateContent({ model, contents: 'OK?', config: { maxOutputTokens: 64, ...(tc ? { thinkingConfig: tc } : {}) } });
      return tc;
    } catch (err) {
      if (!/\b400\b|INVALID_ARGUMENT|thinking|budget/i.test(errorMessage(err))) throw err;
    }
  }
  return undefined;
}

async function analyze(model: string, cfg: GenerateContentConfig, p: Probe) {
  for (let attempt = 0; ; attempt++) {
    try {
      const t0 = performance.now();
      const stream = await ai.models.generateContentStream({ model, contents: userText(p), config: cfg });
      let text = '';
      let decisionAt = Number.NaN;
      for await (const chunk of stream) {
        text += chunk.candidates?.[0]?.content?.parts?.map((x) => (x.thought ? '' : (x.text ?? ''))).join('') ?? '';
        if (Number.isNaN(decisionAt) && /"complete"\s*:\s*(true|false)/.test(text)) decisionAt = performance.now();
      }
      const fullMs = performance.now() - t0;
      return { verdict: JSON.parse(text) as Verdict, decisionMs: decisionAt - t0, fullMs };
    } catch (err) {
      const msg = errorMessage(err);
      if (attempt < 3 && /\b(429|500|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|fetch failed/i.test(msg)) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw new Error(msg);
    }
  }
}

const probes = buildProbes();
type Row = Probe & { model: string; run: number; verdict?: Verdict; decisionMs: number; fullMs: number; error?: string };
const rows: Row[] = [];
for (const model of models) {
  const thinking = await resolveThinking(model);
  const cfg: GenerateContentConfig = {
    systemInstruction: ANALYZER_SYSTEM,
    responseMimeType: 'application/json',
    responseJsonSchema: ANALYZER_SCHEMA,
    maxOutputTokens: 300,
    ...(thinking ? { thinkingConfig: thinking } : {}),
  };
  await analyze(model, cfg, probes[0]!); // warm-up
  console.log(`${model}: thinking=${JSON.stringify(thinking ?? 'default')}, ${probes.length} probes × ${runs} runs`);
  for (let run = 1; run <= runs; run++) {
    for (const p of probes) {
      try {
        const r = await analyze(model, cfg, p);
        rows.push({ ...p, model, run, ...r });
        process.stdout.write('.');
      } catch (err) {
        rows.push({ ...p, model, run, decisionMs: Number.NaN, fullMs: Number.NaN, error: errorMessage(err) });
        process.stdout.write('x');
      }
    }
  }
  console.log();
}

// ---- Accuracy + latency ----
const pctOf = (xs: boolean[]) => (xs.length ? `${Math.round((100 * xs.filter(Boolean).length) / xs.length)}% (${xs.filter(Boolean).length}/${xs.length})` : '—');
const summary = models.map((model) => {
  const ok = rows.filter((r) => r.model === model && r.verdict);
  const ends = ok.filter((r) => r.isEnd);
  const mids = ok.filter((r) => !r.isEnd);
  return {
    model,
    errors: rows.filter((r) => r.model === model && r.error).length,
    decisionP50: percentile(ok.map((r) => r.decisionMs), 50),
    decisionP95: percentile(ok.map((r) => r.decisionMs), 95),
    fullP50: percentile(ok.map((r) => r.fullMs), 50),
    endComplete: pctOf(ends.map((r) => r.verdict!.complete)),
    midNotComplete: pctOf(mids.map((r) => !r.verdict!.complete)),
    action: pctOf(ends.filter((r) => r.expectAction).map((r) => r.verdict!.action === r.expectAction)),
    followUp: pctOf(ends.filter((r) => r.expectFollowUp !== undefined).map((r) => r.verdict!.isFollowUp === r.expectFollowUp)),
  };
});
console.log(
  '\n' +
    table(
      ['model', 'err', 'decision p50', 'decision p95', 'full JSON p50', 'ends → complete', 'mid-pauses → wait', 'action ok', 'follow-up ok'],
      summary.map((s) => [s.model, s.errors, fmtMs(s.decisionP50), fmtMs(s.decisionP95), fmtMs(s.fullP50), s.endComplete, s.midNotComplete, s.action, s.followUp]),
    ),
);

// ---- End-of-turn policy simulation (turns dataset, first model) ----
// A mid-turn pause "fires" (premature) if the policy triggers before the interviewer resumes.
const LISTEN_MS = 300; // local VAD silence before asking the analyzer
const FALLBACK_MS = 1200; // silence after which we treat the turn as finished anyway
const sim = rows.filter((r) => r.model === models[0] && r.dataset === 'turns' && r.verdict);
const ends = sim.filter((r) => r.isEnd);
const mids = sim.filter((r) => !r.isEnd);
const policies = [
  ...[300, 700, 1200].map((x) => ({
    name: `silence only ${x} ms`,
    premature: mids.map((r) => r.pauseMs >= x),
    endDelay: ends.map(() => x),
  })),
  {
    name: `${LISTEN_MS} ms + analyzer (fallback ${FALLBACK_MS} ms)`,
    premature: mids.map((r) => r.pauseMs >= LISTEN_MS && r.verdict!.complete && r.verdict!.confidence >= 0.5),
    endDelay: ends.map((r) => (r.verdict!.complete && r.verdict!.confidence >= 0.5 ? LISTEN_MS + r.decisionMs : FALLBACK_MS)),
  },
];
console.log(
  '\nEnd-of-turn policies (turns dataset, ' + models[0] + '):\n' +
    table(
      ['policy', 'premature triggers at mid-turn pauses', 'end detected after p50', 'p95'],
      policies.map((p) => [p.name, pctOf(p.premature), fmtMs(percentile(p.endDelay, 50)), fmtMs(percentile(p.endDelay, 95))]),
    ),
);

const misses = sim.filter((r) => r.isEnd !== r.verdict!.complete).map((r) => `${r.id}#${r.boundary} ${r.isEnd ? 'END' : 'mid'} "${r.transcript}" → complete=${r.verdict!.complete} (${r.verdict!.confidence})`);
if (misses.length) console.log(`\nMisjudged boundaries:\n  ${[...new Set(misses)].join('\n  ')}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../results/turn-analyzer-${stamp}.json`, import.meta.url), JSON.stringify({ models, runs, summary, rows }, null, 2));
console.log(`\nSaved spikes/results/turn-analyzer-${stamp}.json`);
