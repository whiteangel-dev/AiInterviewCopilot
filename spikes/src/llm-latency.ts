/**
 * Phase 0 — answer-generation latency benchmark (Gemini).
 *
 * Measures, per model, time-to-first-token (TTFT) and total time for streamed
 * interview answers using a realistic cached prefix (rules + profile + knowledge),
 * plus [SKIP] accuracy on non-questions and provider-side cache hits.
 *
 * Usage:
 *   npm run bench:llm -- [--models a,b,c] [--runs 2] [--limit 17]
 *                        [--thinking min|default] [--explicit-cache]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ThinkingLevel } from '@google/genai';
import type { Content, GenerateContentConfig, GenerateContentResponse, ThinkingConfig } from '@google/genai';
import { createClient, errorMessage, parseArgs, sleep } from './lib/env.ts';
import { fmtMs, mean, percentile, table } from './lib/stats.ts';
import { buildContents, buildSystemInstruction, loadQuestions } from './prompt.ts';
import type { Question } from './prompt.ts';
import { listModels, pickTextModels } from './models.ts';

const args = parseArgs();
const runs = Number(args.get('runs') ?? 2);
const limit = args.has('limit') ? Number(args.get('limit')) : undefined;
const thinkingMode = args.get('thinking') ?? 'min';
const useExplicitCache = args.has('explicit-cache');
const MAX_OUTPUT_TOKENS = 1024;

const ai = createClient();
const systemInstruction = buildSystemInstruction();
const questions = loadQuestions().slice(0, limit);
const models = args.get('models')?.split(',').map((s) => s.trim()).filter(Boolean) ?? pickTextModels(await listModels());
if (models.length === 0) {
  console.error('No text models found. Run `npm run models` to see what this key can access, then pass --models.');
  process.exit(1);
}

interface Row {
  model: string;
  run: number;
  qid: string;
  kind: Question['kind'];
  ttftMs: number;
  totalMs: number;
  promptTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  thoughtsTokens?: number;
  skipCorrect: boolean;
  text: string;
  error?: string;
}

/** Visible answer text only (excludes thought parts). */
function chunkText(chunk: GenerateContentResponse): string {
  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
}

const isRetryable = (msg: string) => /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|fetch failed|ECONNRESET/i.test(msg);

async function timedStream(model: string, contents: Content[], config: GenerateContentConfig) {
  for (let attempt = 0; ; attempt++) {
    try {
      const t0 = performance.now();
      const stream = await ai.models.generateContentStream({ model, contents, config });
      let tFirst = Number.NaN;
      let text = '';
      let usage: GenerateContentResponse['usageMetadata'];
      for await (const chunk of stream) {
        const t = chunkText(chunk);
        if (t && Number.isNaN(tFirst)) tFirst = performance.now();
        text += t;
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
      }
      return { ttftMs: tFirst - t0, totalMs: performance.now() - t0, text: text.trim(), usage };
    } catch (err) {
      const msg = errorMessage(err);
      if (attempt < 3 && isRetryable(msg)) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw new Error(msg);
    }
  }
}

/** Finds the lowest-latency thinking setting each model accepts. */
async function resolveThinking(model: string): Promise<ThinkingConfig | undefined> {
  if (thinkingMode === 'default') return undefined;
  const candidates: (ThinkingConfig | undefined)[] = [
    { thinkingBudget: 0 },
    { thinkingLevel: ThinkingLevel.MINIMAL },
    { thinkingLevel: ThinkingLevel.LOW },
    { thinkingBudget: 128 },
    undefined,
  ];
  for (const tc of candidates) {
    try {
      await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
        config: { maxOutputTokens: 256, ...(tc ? { thinkingConfig: tc } : {}) },
      });
      return tc;
    } catch (err) {
      const msg = errorMessage(err);
      if (!/\b400\b|INVALID_ARGUMENT|thinking|budget/i.test(msg)) throw new Error(msg);
    }
  }
  return undefined;
}

const caches = new Map<string, string>();

async function configFor(model: string, thinking: ThinkingConfig | undefined): Promise<GenerateContentConfig> {
  const base: GenerateContentConfig = { maxOutputTokens: MAX_OUTPUT_TOKENS, ...(thinking ? { thinkingConfig: thinking } : {}) };
  if (useExplicitCache) {
    if (!caches.has(model)) {
      try {
        const c = await ai.caches.create({ model, config: { systemInstruction, ttl: '1200s', displayName: 'aic-phase0' } });
        if (c.name) caches.set(model, c.name);
      } catch (err) {
        console.warn(`  explicit cache unavailable for ${model}: ${errorMessage(err)} — using implicit caching`);
        caches.set(model, '');
      }
    }
    const name = caches.get(model);
    if (name) return { ...base, cachedContent: name };
  }
  return { ...base, systemInstruction };
}

const rows: Row[] = [];
const coldTtft = new Map<string, number>();
const settings = new Map<string, GenerateContentConfig>();

console.log(`Models: ${models.join(', ')}`);
console.log(`Questions: ${questions.length} × runs: ${runs}, thinking: ${thinkingMode}, cache: ${useExplicitCache ? 'explicit' : 'implicit'}\n`);

for (const model of models) {
  try {
    const thinking = await resolveThinking(model);
    const cfg = await configFor(model, thinking);
    settings.set(model, cfg);
    // Warm-up (not scored): connection + prefix cache. Its TTFT is reported as "cold".
    const first = questions.find((q) => q.kind === 'answer') ?? questions[0]!;
    const warm = await timedStream(model, buildContents(first, questions), cfg);
    coldTtft.set(model, warm.ttftMs);
    console.log(`${model}: thinking=${JSON.stringify(thinking ?? 'model default')} cold TTFT=${fmtMs(warm.ttftMs)}`);
  } catch (err) {
    console.error(`${model}: setup failed — ${errorMessage(err)}`);
    settings.delete(model);
  }
}

for (let run = 1; run <= runs; run++) {
  for (const q of questions) {
    for (const model of models) {
      const cfg = settings.get(model);
      if (!cfg) continue;
      try {
        const r = await timedStream(model, buildContents(q, questions), cfg);
        const skipped = r.text.startsWith('[SKIP]');
        rows.push({
          model, run, qid: q.id, kind: q.kind, ttftMs: r.ttftMs, totalMs: r.totalMs,
          promptTokens: r.usage?.promptTokenCount, cachedTokens: r.usage?.cachedContentTokenCount,
          outputTokens: r.usage?.candidatesTokenCount, thoughtsTokens: r.usage?.thoughtsTokenCount,
          skipCorrect: q.kind === 'skip' ? skipped : !skipped, text: r.text,
        });
        process.stdout.write('.');
      } catch (err) {
        rows.push({ model, run, qid: q.id, kind: q.kind, ttftMs: Number.NaN, totalMs: Number.NaN, skipCorrect: false, text: '', error: errorMessage(err) });
        process.stdout.write('x');
      }
    }
  }
}
console.log('\n');

for (const [, name] of caches) if (name) await ai.caches.delete({ name }).catch(() => {});

const summary = models.filter((m) => settings.has(m)).map((model) => {
  const rs = rows.filter((r) => r.model === model);
  const ok = rs.filter((r) => !r.error);
  const ttft = ok.map((r) => r.ttftMs);
  const total = ok.map((r) => r.totalMs);
  const cacheRatio = mean(ok.filter((r) => r.promptTokens).map((r) => (r.cachedTokens ?? 0) / (r.promptTokens ?? 1)));
  return {
    model,
    n: ok.length,
    errors: rs.length - ok.length,
    coldTtftMs: coldTtft.get(model) ?? Number.NaN,
    ttftP50: percentile(ttft, 50),
    ttftP95: percentile(ttft, 95),
    totalP50: percentile(total, 50),
    totalP95: percentile(total, 95),
    promptTokens: Math.round(mean(ok.map((r) => r.promptTokens ?? Number.NaN))),
    cacheHitPct: Math.round(cacheRatio * 100),
    outTokens: Math.round(mean(ok.map((r) => r.outputTokens ?? Number.NaN))),
    thoughtTokens: Math.round(mean(ok.map((r) => r.thoughtsTokens ?? 0))),
    skipAccuracy: `${ok.filter((r) => r.skipCorrect).length}/${ok.length}`,
  };
});

console.log(
  table(
    ['model', 'n', 'err', 'cold TTFT', 'TTFT p50', 'TTFT p95', 'total p50', 'total p95', 'prompt tok', 'cached %', 'out tok', 'think tok', 'skip/answer ok'],
    summary.map((s) => [
      s.model, s.n, s.errors, fmtMs(s.coldTtftMs), fmtMs(s.ttftP50), fmtMs(s.ttftP95), fmtMs(s.totalP50), fmtMs(s.totalP95),
      s.promptTokens, `${s.cacheHitPct}%`, s.outTokens, s.thoughtTokens, s.skipAccuracy,
    ]),
  ),
);

const errs = rows.filter((r) => r.error);
if (errs.length) console.log(`\nFirst error: ${errs[0]!.model} ${errs[0]!.qid}: ${errs[0]!.error}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = new URL('../results/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL(`llm-latency-${stamp}.json`, dir), JSON.stringify({ models, runs, thinkingMode, useExplicitCache, summary, rows }, null, 2));

// Human-readable answers (run 1) for quality review.
const md = [`# LLM answers — ${stamp}\n`];
for (const q of questions) {
  md.push(`## ${q.id} (${q.type}${q.kind === 'skip' ? ', expected [SKIP]' : ''})\n> ${q.text}\n`);
  for (const model of models) {
    const r = rows.find((x) => x.model === model && x.qid === q.id && x.run === 1);
    if (r) md.push(`**${model}** — TTFT ${fmtMs(r.ttftMs)}\n\n${r.error ? `ERROR: ${r.error}` : r.text}\n`);
  }
}
writeFileSync(new URL(`llm-answers-${stamp}.md`, dir), md.join('\n'));
console.log(`\nSaved spikes/results/llm-latency-${stamp}.json and llm-answers-${stamp}.md`);
