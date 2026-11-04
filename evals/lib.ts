/**
 * Shared helpers for the opt-in evaluations. They call the real Gemini API
 * with the key in .env.local (or GEMINI_API_KEY) and only run with
 * AIC_LIVE_TESTS=1. Fixtures are the Phase 0 ones (spikes/src/fixtures, and
 * the speech clips from `cd spikes && npm run gen-audio`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeItemFields } from '@aic/ipc';
import { buildSessionContext, compileKnowledge } from '@aic/prompts';

export const ROOT = join(__dirname, '..');
export const FIXTURES = join(ROOT, 'spikes/src/fixtures');
export const AUDIO = join(ROOT, 'spikes/fixtures/audio');

function devKey(): string | undefined {
  try {
    const text = readFileSync(join(ROOT, '.env.local'), 'utf8');
    return /^\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|API_KEY)\s*[=:]\s*"?([^"\s]+)"?/m.exec(
      text,
    )?.[1];
  } catch {
    return undefined;
  }
}

/** The API key, or undefined when evaluations are off. */
export const API_KEY =
  process.env.AIC_LIVE_TESTS === '1' ? (process.env.GEMINI_API_KEY ?? devKey()) : undefined;

export const hasAudio = () => existsSync(join(AUDIO, 'manifest.json'));

export interface Question {
  id: string;
  kind: 'answer' | 'skip';
  type: string;
  text: string;
  parent?: string;
  candidateSaid?: string;
}

export interface Turn {
  id: string;
  phrases: string[];
  pausesMs: number[];
  final: 'answer' | 'ignore';
  context?: { question: string; candidateSaid: string };
}

export interface Clip {
  id: string;
  kind: 'answer' | 'skip';
  text: string;
  file: string;
  durationMs: number;
  speechStartMs: number;
  speechEndMs: number;
}

const json = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T;
export const loadQuestions = () => json<Question[]>(join(FIXTURES, 'questions.json'));
export const loadTurns = () => json<Turn[]>(join(FIXTURES, 'turns.json'));
export const loadClips = () => json<Clip[]>(join(AUDIO, 'manifest.json'));
export const loadProfileBrief = () => readFileSync(join(FIXTURES, 'profile.md'), 'utf8').trim();
export const loadKnowledgeNotes = () => readFileSync(join(FIXTURES, 'knowledge.md'), 'utf8');

export function percentile(values: readonly number[], p: number): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i]!;
}

export const ms = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} ms` : '-');

/** Saves a result file under evals/results/ and returns its path. */
export function saveResult(name: string, data: unknown): string {
  const dir = join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** Prints to stdout (vitest shows it with --silent=false). */
export function report(lines: string | string[]): void {
  process.stdout.write(`${Array.isArray(lines) ? lines.join('\n') : lines}\n`);
}

/** knowledge.md → notes: "Answer instructions" are instructions, the rest facts. */
export function knowledgeItems(): KnowledgeItemFields[] {
  const items: KnowledgeItemFields[] = [];
  let section = '';
  for (const line of loadKnowledgeNotes().split('\n')) {
    if (line.startsWith('## ')) section = line.slice(3).trim();
    else if (line.startsWith('- ')) {
      items.push({
        kind: section === 'Answer instructions' ? 'instruction' : 'fact',
        category:
          section === 'Answer instructions'
            ? 'style'
            : section === 'Target company'
              ? 'company'
              : 'experience',
        title: '',
        content: line.slice(2).trim(),
      });
    }
  }
  return items;
}

/** The session context the app builds for the fixture candidate. */
export function fixtureContext(): string {
  return buildSessionContext({
    today: '2026-11-04',
    company: 'Kestrel Pay',
    role: 'Senior Backend Engineer, Ledger team',
    brief: loadProfileBrief(),
    knowledge: compileKnowledge(knowledgeItems()),
  }).text;
}
