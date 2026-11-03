/**
 * Lists the Gemini models available to this API key and what each supports.
 * Usage: npm run models
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Model } from '@google/genai';
import { createClient, errorMessage } from './lib/env.ts';
import { table } from './lib/stats.ts';

export interface ModelInfo {
  name: string;
  displayName: string;
  actions: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  tags: string[];
}

export async function listModels(): Promise<ModelInfo[]> {
  const ai = createClient();
  const out: ModelInfo[] = [];
  const pager = await ai.models.list({ config: { pageSize: 100 } });
  for await (const m of pager as AsyncIterable<Model>) {
    const name = (m.name ?? '').replace(/^models\//, '');
    const actions = m.supportedActions ?? [];
    const tags: string[] = [];
    if (actions.includes('bidiGenerateContent')) tags.push('live');
    if (/tts/.test(name)) tags.push('tts');
    else if (actions.includes('generateContent')) tags.push('text');
    if (actions.some((a) => /embed/i.test(a))) tags.push('embed');
    if (/image|veo|imagen|lyria|robotics|computer-use/.test(name)) tags.push('other');
    out.push({ name, displayName: m.displayName ?? '', actions, inputTokenLimit: m.inputTokenLimit, outputTokenLimit: m.outputTokenLimit, tags });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const versionOf = (name: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? 0);

/** Sorts model names newest version first; stable before preview at equal version. */
export function byNewest(names: string[]): string[] {
  return [...names].sort((a, b) => versionOf(b) - versionOf(a) || Number(/preview/.test(a)) - Number(/preview/.test(b)));
}

/** Newest explicitly-versioned text model per tier (flash-lite, flash, pro). Opaque "-latest" aliases are skipped. */
export function pickTextModels(models: ModelInfo[]): string[] {
  const names = models.filter((m) => m.tags.includes('text')).map((m) => m.name);
  const picks: string[] = [];
  for (const tier of ['flash-lite', 'flash', 'pro'] as const) {
    const re = new RegExp(`^gemini-\\d+(?:\\.\\d+)?-${tier}(?:-preview)?$`);
    const best = byNewest(names.filter((n) => re.test(n)))[0];
    if (best) picks.push(best);
  }
  return picks;
}

if (import.meta.main) {
  try {
    const models = await listModels();
    mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
    writeFileSync(new URL('../results/models.json', import.meta.url), JSON.stringify(models, null, 2));
    const relevant = models.filter((m) => !m.tags.includes('other') && m.tags.length > 0);
    console.log(
      table(
        ['model', 'tags', 'input limit', 'actions'],
        relevant.map((m) => [m.name, m.tags.join(','), m.inputTokenLimit ?? '', m.actions.join(',')]),
      ),
    );
    console.log(`\n${models.length} models total (${relevant.length} shown). Full list: spikes/results/models.json`);
    console.log(`Auto-picked text models for the LLM benchmark: ${pickTextModels(models).join(', ') || '(none)'}`);
  } catch (err) {
    console.error(errorMessage(err));
    process.exit(1);
  }
}
