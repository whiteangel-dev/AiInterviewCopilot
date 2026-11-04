/**
 * Transcription timing (Phase 7): how soon after the interviewer's last word
 * the transcript holds the whole question, for different ways of ending the
 * audio stream. This is the biggest part of the time to an answer.
 *
 * Variants (AIC_EVAL_STT_TAILS, ms of audio after the local pause, default
 * "800,0"): after that much silence the stream is ended (`audioStreamEnd`),
 * which asks the service to finish the utterance.
 *
 * The 17 Phase 0 clips play in real time through the production stream and
 * the local voice detector, as in the app. About 4 minutes for two variants.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_LIVE_TIMING,
  FRAME_SAMPLES,
  GeminiLiveStt,
  VoiceActivityDetector,
  levelDb,
  readWav,
} from '@aic/core';
import { DEFAULT_MODELS } from '@aic/ipc';
import { describe, expect, it } from 'vitest';
import { API_KEY, AUDIO, hasAudio, loadClips, ms, percentile, report, saveResult } from './lib';

const TAILS = (process.env.AIC_EVAL_STT_TAILS ?? '800,0').split(',').map(Number);
const GAP_MS = 2500;

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Share of the reference's words present in the heard text. */
function coverage(reference: string, heard: string): number {
  const have = new Set(words(heard));
  const want = words(reference);
  return want.filter((w) => have.has(w)).length / Math.max(1, want.length);
}

async function runVariant(tailMs: number) {
  const clips = loadClips();
  const stt = new GeminiLiveStt(undefined, {
    ...DEFAULT_LIVE_TIMING,
    gate: { ...DEFAULT_LIVE_TIMING.gate!, tailMs },
  });
  let current = -1;
  const t0 = performance.now();
  const ends: number[] = [];
  const complete: number[] = clips.map(() => Number.NaN);
  const finalAt: number[] = clips.map(() => Number.NaN);
  const heard: string[] = clips.map(() => '');
  const onText = (text: string, final: boolean) => {
    const i = current;
    if (i < 0) return;
    const now = performance.now() - t0;
    heard[i] = final ? `${heard[i]} ${text}`.trim() : text;
    if (ends[i]) timeline[i]!.push({ at: now - ends[i], text: final ? finals : text });
    const full = final ? heard[i] : `${heard[i]}`;
    if (Number.isNaN(complete[i]!) && coverage(clips[i]!.text, full) >= 0.9 && ends[i]) {
      complete[i] = now - ends[i];
    }
    if (final && ends[i]) finalAt[i] = now - ends[i];
  };
  let finals = '';
  /** Per clip: what the transcript said at each change, with the time after the last word. */
  const timeline: { at: number; text: string }[][] = clips.map(() => []);
  const atPause: string[] = clips.map(() => '');
  const stream = stt.open(
    { apiKey: API_KEY!, model: DEFAULT_MODELS.transcription, vocabulary: [], label: 'interviewer' },
    {
      onInterim: (t) => onText(`${finals} ${t}`.trim(), false),
      onFinal: (t) => {
        finals = `${finals} ${t}`.trim();
        onText(t, true);
      },
      onState: () => undefined,
    },
  );
  await new Promise((r) => setTimeout(r, 1500));
  const vad = new VoiceActivityDetector();
  const start = performance.now();
  let sent = 0;
  for (const [i, clip] of clips.entries()) {
    current = i;
    finals = '';
    const samples = readWav(readFileSync(join(AUDIO, clip.file))).samples;
    const all = new Int16Array(samples.length + 16 * GAP_MS);
    all.set(samples);
    const clipStart = sent;
    ends[i] = ((clipStart + clip.speechEndMs * 16) / 16_000) * 1000 + (start - t0);
    for (let o = 0; o + FRAME_SAMPLES <= all.length; o += FRAME_SAMPLES) {
      const wait = start + (sent / 16_000) * 1000 - performance.now();
      if (wait > 1) await new Promise((r) => setTimeout(r, wait));
      const frame = all.subarray(o, o + FRAME_SAMPLES);
      const was = vad.speaking;
      vad.push(levelDb(frame));
      // The local pause after the clip's speech: what an attempt would start with.
      if (was && !vad.speaking && sent / 16 > clipStart / 16 + clip.speechEndMs - 400) {
        const last = timeline[i]!.at(-1);
        atPause[i] = last?.text ?? '';
      }
      stream.write(frame, vad.speaking);
      sent += FRAME_SAMPLES;
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
  const audioSeconds = stream.stats.audioSeconds;
  stream.close();
  return { clips, complete, finalAt, heard, audioSeconds, timeline, atPause };
}

describe.skipIf(!API_KEY || !hasAudio())('transcription timing (real Gemini)', () => {
  it('measures when the whole question is in the transcript', async () => {
    const results = [];
    for (const tail of TAILS) {
      const r = await runVariant(tail);
      const complete = r.complete.filter(Number.isFinite);
      const finals = r.finalAt.filter(Number.isFinite);
      results.push({
        tail,
        complete: r.complete,
        finalAt: r.finalAt,
        audioSeconds: r.audioSeconds,
      });
      report([
        '',
        `End the stream ${tail} ms after the pause:`,
        `  whole question in the transcript: p50 ${ms(percentile(complete, 50))} · p95 ${ms(percentile(complete, 95))} after the last word (${complete.length}/${r.clips.length})`,
        `  final text: p50 ${ms(percentile(finals, 50))} · p95 ${ms(percentile(finals, 95))}`,
        `  audio sent: ${Math.round(r.audioSeconds)} s`,
        ...r.clips.map((c, i) => {
          const tl = r.timeline[i]!;
          const last = tl.at(-1)?.text ?? '';
          // When the transcript first had its final words (ignoring punctuation).
          const settled = tl.find((e) => norm(e.text) === norm(last))?.at;
          const same = norm(r.atPause[i]!) === norm(last);
          return `  ${c.id}: at pause ${same ? 'SAME words' : 'differs'} · words settled +${ms(settled ?? NaN)}\n      pause: "${r.atPause[i]}"\n      final: "${last}"`;
        }),
        ...r.clips
          .map((c, i) => ({ c, i }))
          .filter(({ c, i }) => coverage(c.text, r.heard[i]!) < 0.9)
          .map(({ c, i }) => `  incomplete ${c.id}: "${r.heard[i]}"`),
      ]);
    }
    saveResult('stt-timing', results);
    expect(results.length).toBe(TAILS.length);
  }, 900_000);
});
