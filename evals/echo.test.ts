/**
 * Echo evaluation (Phase 5): an interview on laptop speakers, without
 * headphones. The microphone hears the interviewer through a simulated room
 * (50 ms delay, a decaying tail, 10 dB quieter) plus a little noise, and the
 * candidate answers in a gap. The whole engine runs with real Gemini, with
 * echo cancellation off and then on.
 *
 * Measures: interviewer words that leak into the candidate's transcript, and
 * whether the candidate's own answer still comes through. Also reports the
 * audio sent for transcription (only speech is sent). About 1.5 minutes.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav, readWav, transcriptSimilarity } from '@aic/core';
import type { EngineEvents, LiveTranscriptUpdate } from '@aic/ipc';
import { afterAll, describe, expect, it } from 'vitest';
import { createEngine } from '../apps/desktop/src/engine/engine';
import { API_KEY, AUDIO, hasAudio, loadClips, report, saveResult } from './lib';

const RATE = 16_000;
const GAP_MS = 4000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/** Interviewer clips with gaps; the candidate's clip plays in the first gap. */
function buildTracks(dir: string) {
  const clips = loadClips();
  const asked = clips.slice(0, 4);
  const answer = clips[6]!;
  const read = (file: string) => readWav(readFileSync(join(AUDIO, file))).samples;
  const parts = asked.map((c) => read(c.file));
  const total = parts.reduce((n, p) => n + p.length + (GAP_MS * RATE) / 1000, RATE / 2);
  const interviewer = new Float64Array(total);
  let at = RATE / 2;
  const firstGap = at + parts[0]!.length;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) interviewer[at + i] = p[i]! / 32_768;
    at += p.length + (GAP_MS * RATE) / 1000;
  }
  // The room: 50 ms delay, 10 dB down, a decaying tail; plus noise at −60 dBFS.
  const r = rng(11);
  const delay = Math.round(0.05 * RATE);
  const taps: [number, number][] = [[delay, 0.32]];
  for (let i = 1; i < 2400; i += 3) taps.push([delay + i, 0.06 * r() * Math.exp(-i / 500)]);
  const mic = new Float64Array(total);
  for (let n = 0; n < total; n++) {
    let s = 0;
    for (const [k, g] of taps) if (n >= k) s += g * interviewer[n - k]!;
    mic[n] = s + 0.001 * r();
  }
  const candidate = read(answer.file);
  const start = firstGap + RATE / 2;
  for (let i = 0; i < candidate.length && start + i < total; i++) {
    mic[start + i]! += (candidate[i]! / 32_768) * 0.8;
  }
  const write = (name: string, x: Float64Array) => {
    const pcm = Int16Array.from(x, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32_767));
    const file = join(dir, name);
    writeFileSync(file, encodeWav(pcm));
    return file;
  };
  return {
    interviewer: write('interviewer.wav', interviewer),
    candidate: write('candidate.wav', mic),
    asked,
    answer,
    durationMs: (total / RATE) * 1000,
  };
}

async function runInterview(
  dir: string,
  tracks: ReturnType<typeof buildTracks>,
  echoCancellation: boolean,
) {
  const updates: LiveTranscriptUpdate[] = [];
  const engine = createEngine({
    emit: (event: keyof EngineEvents, data: unknown) => {
      if (event === 'live.transcript') updates.push(data as LiveTranscriptUpdate);
    },
    exit: () => undefined,
    logToConsole: process.env.AIC_LIVE_VERBOSE === '1',
  });
  const h = engine.handlers;
  const run = join(dir, echoCancellation ? 'on' : 'off');
  await h.init({
    dbPath: join(run, 'app.db'),
    dbKeyHex: randomBytes(32).toString('hex'),
    backupDir: join(run, 'bk'),
    logDir: join(run, 'logs'),
    appVersion: 'eval',
    fakeProvider: false,
    nativeAudioPath: null,
    audioReplay: { interviewer: tracks.interviewer, candidate: tracks.candidate },
  });
  await h['apiKey.activate']({
    provider: 'gemini',
    key: API_KEY!,
    verification: null,
    models: null,
  });
  // Answers aren't part of this check.
  await h['settings.update']({
    audio: { echoCancellation },
    answers: { autoAnswer: false, factCheck: false },
  });
  const started = await h['live.start']({
    mode: 'interview',
    title: 'Echo',
    profileId: null,
    knowledgeBaseId: null,
    transcribe: true,
  });
  await new Promise((r) => setTimeout(r, tracks.durationMs + 3000));
  const diagnostics = await h['live.diagnostics']();
  await h['live.stop']();
  const detail = await h['sessions.get']({ id: started.id });
  await h.shutdown();
  const said = detail.segments.filter((s) => s.channel === 'candidate').map((s) => s.text);
  const echoStats = /"echoCancellation": (\{[^}]*\}|null)/.exec(diagnostics)?.[1] ?? 'null';
  return { said, stats: detail.stats, durationMs: detail.durationMs, echoStats };
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);

describe.skipIf(!API_KEY || !hasAudio())('echo cancellation (real Gemini, whole engine)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aic-eval-echo-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps the interviewer out of the candidate transcript', async () => {
    const tracks = buildTracks(dir);
    const interviewerWords = new Set(tracks.asked.flatMap((c) => words(c.text)));
    const answerWords = new Set(words(tracks.answer.text));
    const results = [];
    for (const on of [false, true]) {
      const r = await runInterview(dir, tracks, on);
      const heard = r.said.join(' ');
      const leaked = words(heard).filter((w) => interviewerWords.has(w) && !answerWords.has(w));
      const answerSimilarity = Math.max(
        0,
        ...r.said.map((t) => transcriptSimilarity(tracks.answer.text, t)),
      );
      const sent = r.stats?.audioSeconds;
      results.push({
        on,
        leaked: leaked.length,
        answerSimilarity,
        sent,
        said: r.said,
        echo: r.echoStats,
      });
      report([
        '',
        `Echo cancellation ${on ? 'ON' : 'OFF'}: interviewer words in the candidate transcript: ${leaked.length}; candidate's answer similarity ${answerSimilarity.toFixed(2)}`,
        `  audio sent for transcription: interviewer ${sent?.interviewer} s, candidate ${sent?.candidate} s, of ${Math.round(r.durationMs / 1000)} s listened`,
        `  canceller: ${r.echoStats}`,
        ...r.said.map((t) => `  candidate: ${t}`),
      ]);
    }
    saveResult('echo', { results });
    const [off, on] = results;
    expect(on!.leaked).toBeLessThan(Math.max(3, off!.leaked / 3));
    expect(on!.answerSimilarity).toBeGreaterThan(0.7);
  }, 300_000);
});
