/**
 * Live answers evaluation (Phase 4): the whole engine with real Gemini, as in
 * an interview. The 17 Phase 0 interviewer clips play back to back in real
 * time through capture → voice detection → Gemini Live transcription → turn
 * taking (analyzer ∥ speculative answer) → the answer on screen.
 *
 * Measures, per question: the interviewer's last word → the first answer word
 * shown, and whether the outcome is right (answered, or no answer for a
 * statement or filler). Phase 0's prototype: p50 971 ms, p95 1,241 ms, 17/17.
 *
 * The candidate is the Phase 0 fixture (profile.md as the brief, knowledge.md
 * as notes). About 2.5 minutes; costs about a cent.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav, readWav } from '@aic/core';
import { KnowledgeRepository, ProfileRepository, SessionRepository, openDatabase } from '@aic/db';
import {
  EMPTY_PROFILE,
  type EngineEvents,
  type KnowledgeItemFields,
  type LiveAnswer,
} from '@aic/ipc';
import { afterAll, describe, expect, it } from 'vitest';
import { createEngine } from '../apps/desktop/src/engine/engine';
import {
  API_KEY,
  AUDIO,
  hasAudio,
  loadClips,
  loadKnowledgeNotes,
  loadProfileBrief,
  ms,
  percentile,
  report,
  saveResult,
  type Clip,
} from './lib';

const RATE = 16_000;
const LEAD_MS = 800;
/** Silence added after each clip (each clip already ends with ~2 s of silence). */
const GAP_MS = 1000;

function buildTrack(dir: string, clips: Clip[]) {
  const parts: Int16Array[] = [new Int16Array((RATE * LEAD_MS) / 1000)];
  const ends: number[] = [];
  let at = LEAD_MS;
  for (const clip of clips) {
    const wav = readWav(readFileSync(join(AUDIO, clip.file)));
    parts.push(wav.samples, new Int16Array((RATE * GAP_MS) / 1000));
    ends.push(at + clip.speechEndMs);
    at += (wav.samples.length / RATE) * 1000 + GAP_MS;
  }
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const file = join(dir, 'interviewer.wav');
  writeFileSync(file, encodeWav(all));
  return { file, ends, durationMs: at };
}

/** knowledge.md → notes: "Answer instructions" are instructions, the rest facts. */
function knowledgeItems(): KnowledgeItemFields[] {
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

describe.skipIf(!API_KEY || !hasAudio())('live answers (real Gemini, whole engine)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aic-eval-live-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('answers each question about a second after the interviewer stops', async () => {
    const clips = loadClips();
    const track = buildTrack(dir, clips);

    // The Phase 0 candidate, stored the way the app stores it.
    const dbPath = join(dir, 'app.db');
    const dbKeyHex = randomBytes(32).toString('hex');
    const db = openDatabase({ path: dbPath, keyHex: dbKeyHex, backupDir: join(dir, 'bk') });
    const profile = new ProfileRepository(db.db).create('Jordan Rivera');
    new ProfileRepository(db.db).addVersion(profile.id, {
      origin: 'edited',
      documentId: null,
      data: { ...EMPTY_PROFILE, name: 'Jordan Rivera', headline: 'Senior Backend Engineer' },
      brief: loadProfileBrief(),
      model: null,
      promptVersion: null,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
    });
    const knowledge = new KnowledgeRepository(db.db);
    const base = knowledge.createBase('Kestrel Pay');
    knowledge.addItems(base.id, knowledgeItems());
    db.close();

    const answers: LiveAnswer[] = [];
    const engine = createEngine({
      emit: (event: keyof EngineEvents, data: unknown) => {
        if (event === 'live.answer') answers.push(data as LiveAnswer);
      },
      exit: () => undefined,
      logToConsole: process.env.AIC_LIVE_VERBOSE === '1',
      today: () => '2026-11-04',
    });
    const h = engine.handlers;
    await h.init({
      dbPath,
      dbKeyHex,
      backupDir: join(dir, 'bk'),
      logDir: join(dir, 'logs'),
      appVersion: 'eval',
      fakeProvider: false,
      nativeAudioPath: null,
      audioReplay: { interviewer: track.file, candidate: null },
    });
    await h['apiKey.activate']({
      provider: 'gemini',
      key: API_KEY!,
      verification: null,
      models: null,
    });
    const settings = await h['settings.get']();

    const started = await h['live.start']({
      mode: 'interview',
      title: 'Eval',
      profileId: profile.id,
      knowledgeBaseId: base.id,
      transcribe: true,
      company: 'Kestrel Pay',
      role: 'Senior Backend Engineer, Ledger team',
    });
    await new Promise((r) => setTimeout(r, track.durationMs + 5000));
    const final = await h['live.stop']();
    const detail = await h['sessions.get']({ id: started.id });
    await h.shutdown();

    // Timing details the app saves with each answer.
    const reopened = openDatabase({ path: dbPath, keyHex: dbKeyHex, backupDir: join(dir, 'bk') });
    const saved = new Map(
      new SessionRepository(reopened.db).answers(started.id).map((a) => [a.id, a]),
    );
    reopened.close();

    // The latest state of each answer, and when it was first shown.
    const byId = new Map<string, LiveAnswer>();
    for (const a of answers) byId.set(a.id, a);
    const shown = [...byId.values()].filter((a) => a.status !== 'withdrawn');
    const withdrawn = [...byId.values()].filter((a) => a.status === 'withdrawn').length;
    // Each answer belongs to the clip whose speech ended last before it was asked.
    const clipOf = (a: LiveAnswer) => {
      let index = -1;
      track.ends.forEach((end, i) => {
        if (end <= a.askedAtMs + 600) index = i;
      });
      return index;
    };

    const rows = clips.map((clip, i) => {
      const mine = shown.filter((a) => clipOf(a) === i && a.trigger !== 'regenerate');
      const first = mine[0];
      const latency = first ? first.createdAt - (started.startedAt + track.ends[i]!) : Number.NaN;
      const ok = clip.kind === 'answer' ? mine.length > 0 : mine.length === 0;
      const row = first ? saved.get(first.id) : undefined;
      // Time to first text (model) and when the request started, after the last word.
      const ttft = row?.firstTextMs ?? Number.NaN;
      const requestAt = first ? latency - ttft : Number.NaN;
      return {
        ttft,
        requestAt,
        cachedTokens: row?.cachedTokens ?? null,
        inputTokens: row?.inputTokens ?? null,
        id: clip.id,
        expected: clip.kind,
        ok,
        latency,
        trigger: first?.trigger ?? '',
        source: first?.source ?? '',
        heard: first?.heard ?? '',
        question: first?.question ?? '',
        answer: first?.text ?? '',
        status: first?.status ?? '',
      };
    });
    const answered = rows.filter((r) => r.expected === 'answer' && r.ok);
    const latencies = answered.map((r) => r.latency);
    const correct = rows.filter((r) => r.ok).length;
    report([
      '',
      `Live answers: ${settings.models.transcription} → ${settings.models.turnAnalyzer} ∥ ${settings.models.answerFast}`,
      ...rows.map(
        (r) =>
          `${r.ok ? '✓' : '✗'} ${r.id} ${r.expected.padEnd(6)} ${ms(r.latency).padStart(8)} (request +${ms(r.requestAt)}, first text ${ms(r.ttft)}) ${r.trigger.padEnd(13)} ${r.question}\n${r.answer
            .split('\n')
            .map((l) => `      ${l}`)
            .join('\n')}`,
      ),
      `last word → first answer word: p50 ${ms(percentile(latencies, 50))} · p95 ${ms(percentile(latencies, 95))} · max ${ms(Math.max(...latencies))}`,
      `  of which: last word → answer request p50 ${ms(
        percentile(
          answered.map((r) => r.requestAt),
          50,
        ),
      )} · request → first text p50 ${ms(
        percentile(
          answered.map((r) => r.ttft),
          50,
        ),
      )} (the request may start before the question is confirmed)`,
      `  input tokens p50 ${percentile(
        answered.map((r) => r.inputTokens ?? Number.NaN),
        50,
      )} · cached p50 ${percentile(
        answered.map((r) => r.cachedTokens ?? Number.NaN),
        50,
      )}`,
      `correct outcome ${correct}/${rows.length} · withdrawn ${withdrawn} · turns ${JSON.stringify(final?.mode ? detail.stats?.turns : null)}`,
      `saved ${saveResult('live-answers', { settings: settings.models, rows, stats: detail.stats, withdrawn })}`,
    ]);

    expect(correct).toBeGreaterThanOrEqual(clips.length - 2);
    expect(percentile(latencies, 50)).toBeLessThan(1500);
    expect(detail.answers.length).toBeGreaterThanOrEqual(answered.length);
  }, 300_000);
});
