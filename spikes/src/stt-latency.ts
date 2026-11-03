/**
 * Phase 0 — streaming transcription latency benchmark (Gemini Live API).
 *
 * Streams the fixture clips back-to-back at real-time pace (20 ms chunks) over one
 * Live session, the way the app will stream the interviewer channel, and measures:
 *   - first interim text after speech starts (is there word-by-word partial text?)
 *   - server end-of-speech detection delay (VAD ACTIVITY_END vs. actual speech end)
 *   - final transcript delay after speech end
 *   - word error rate (WER) against the known script
 *
 * Usage: npm run bench:stt -- [--model <live-model>] [--vad-silence 500]
 *                              [--clips q02,q05] [--no-vocab] [--wav path/to/real.wav]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ActivityHandling, EndSensitivity, Modality, StartSensitivity, VadSignalType, VoiceActivityType } from '@google/genai';
import type { LiveConnectConfig, LiveServerMessage, Session } from '@google/genai';
import { createClient, errorMessage, parseArgs, sleep } from './lib/env.ts';
import { fmtMs, mean, percentile, table } from './lib/stats.ts';
import { wordErrorRate } from './lib/text.ts';
import { concat, readWav, silence } from './lib/wav.ts';
import type { Clip } from './gen-audio.ts';
import { AUDIO_DIR, loadManifest } from './gen-audio.ts';
import { KEY_TERMS } from './prompt.ts';
import { byNewest, listModels } from './models.ts';

const args = parseArgs();
const RATE = 16000;
const CHUNK = 320; // 20 ms
const GAP_MS = 1000;
const vadSilenceMs = Number(args.get('vad-silence') ?? 500);
const ai = createClient();

// ---- Audio plan: clips back-to-back with gaps, absolute sample offsets per clip ----
let clips: Clip[];
if (args.has('wav')) {
  // A real recording (e.g. from the Windows capture spike): transcript-quality review only (no reference text or known speech boundaries).
  const wav = readWav(args.get('wav')!);
  if (wav.sampleRate !== RATE) throw new Error('Pass a 16 kHz mono WAV');
  clips = [{ id: 'real', kind: 'answer', text: '', file: args.get('wav')!, voice: '-', sampleRate: RATE, durationMs: (wav.samples.length / RATE) * 1000, speechStartMs: 0, speechEndMs: (wav.samples.length / RATE) * 1000 }];
} else {
  const only = args.get('clips')?.split(',');
  clips = loadManifest().filter((c) => !only || only.includes(c.id));
}
if (clips.length === 0) {
  console.error('No clips. Run `npm run gen-audio` first.');
  process.exit(1);
}

interface Track {
  clip: Clip;
  speechStartSample: number;
  speechEndSample: number;
  speechStartAt?: number;
  speechEndAt?: number;
  firstInterimAt?: number;
  interimCount: number;
  lastInterim: string;
  finalText: string;
  lastFinalAt?: number;
  finishedAt?: number;
  activityEndAt?: number;
  turnCompleteAt?: number;
}

const parts: Int16Array[] = [];
const tracks: Track[] = [];
let offset = 0;
for (const clip of clips) {
  const s = args.has('wav') ? readWav(clip.file).samples : readWav(new URL(clip.file, AUDIO_DIR).pathname).samples;
  tracks.push({
    clip,
    speechStartSample: offset + Math.round((clip.speechStartMs / 1000) * RATE),
    speechEndSample: offset + Math.round((clip.speechEndMs / 1000) * RATE),
    interimCount: 0, lastInterim: '', finalText: '',
  });
  parts.push(s, silence(RATE, GAP_MS));
  offset += s.length + Math.round((GAP_MS / 1000) * RATE);
}
const stream = concat(...parts);

// The clip a server event belongs to: the latest one whose speech has started.
const current = () => [...tracks].reverse().find((t) => t.speechStartAt !== undefined);
let inputTokens = 0;
let outputTokens = 0;

function onMessage(msg: LiveServerMessage) {
  const now = performance.now();
  const t = current();
  const sc = msg.serverContent;
  if (msg.usageMetadata) {
    inputTokens = msg.usageMetadata.promptTokenCount ?? inputTokens;
    outputTokens += msg.usageMetadata.responseTokenCount ?? 0;
  }
  if (!t) return;
  if (sc?.interimInputTranscription?.text) {
    t.firstInterimAt ??= now;
    t.interimCount++;
    t.lastInterim = sc.interimInputTranscription.text;
  }
  if (sc?.inputTranscription?.text) {
    t.finalText += sc.inputTranscription.text;
    t.lastFinalAt = now;
  }
  if (sc?.inputTranscription?.finished) t.finishedAt ??= now;
  if (sc?.turnComplete && t.speechEndAt !== undefined) t.turnCompleteAt ??= now;
  const ended =
    msg.voiceActivity?.voiceActivityType === VoiceActivityType.ACTIVITY_END ||
    msg.voiceActivityDetectionSignal?.vadSignalType === VadSignalType.VAD_SIGNAL_TYPE_EOS;
  if (ended && t.speechEndAt !== undefined) t.activityEndAt ??= now;
}

async function connect(model: string, modality: Modality, vocab: boolean): Promise<Session> {
  const config: LiveConnectConfig = {
    responseModalities: [modality],
    systemInstruction: 'You are a silent transcription relay. Never answer or comment. If a reply is required, reply with a single period.',
    inputAudioTranscription: { languageCodes: ['en-US'], ...(vocab ? { customVocabulary: KEY_TERMS } : {}) },
    realtimeInputConfig: {
      automaticActivityDetection: {
        silenceDurationMs: vadSilenceMs,
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
      },
      activityHandling: ActivityHandling.NO_INTERRUPTION,
    },
  };
  let setupDone: () => void = () => {};
  let setupFailed: (e: Error) => void = () => {};
  const ready = new Promise<void>((res, rej) => { setupDone = res; setupFailed = rej; });
  const session = await ai.live.connect({
    model,
    config,
    callbacks: {
      onmessage: (m) => { if (m.setupComplete) setupDone(); onMessage(m); },
      onerror: (e) => setupFailed(new Error(errorMessage(e.message ?? e))),
      onclose: (e) => setupFailed(new Error(`closed ${e.code}: ${errorMessage(e.reason)}`)),
    },
  });
  await Promise.race([ready, sleep(10000).then(() => { throw new Error('setup timeout'); })]);
  return session;
}

// ---- Model + session setup with graceful fallbacks ----
// Prefer dedicated transcription models, then general live models, then native-audio ones.
const liveModels = byNewest((await listModels()).filter((m) => m.tags.includes('live') && !/translate/.test(m.name)).map((m) => m.name));
const rank = (n: string) => (/transcribe/.test(n) ? 0 : /native-audio/.test(n) ? 2 : 1);
const candidates = args.has('model') ? [args.get('model')!] : [...liveModels].sort((a, b) => rank(a) - rank(b));
if (candidates.length === 0) {
  console.error('No Live (bidiGenerateContent) models available to this key. See `npm run models`.');
  process.exit(1);
}
let session: Session | undefined;
let used = '';
outer: for (const model of candidates) {
  for (const modality of [Modality.TEXT, Modality.AUDIO]) {
    for (const vocab of args.has('no-vocab') ? [false] : [true, false]) {
      try {
        session = await connect(model, modality, vocab);
        used = `${model} (response=${modality}, vocab=${vocab})`;
        break outer;
      } catch (err) {
        console.log(`  setup failed: ${model} response=${modality} vocab=${vocab}: ${errorMessage(err)}`);
      }
    }
  }
}
if (!session) process.exit(1);
console.log(`Live model: ${used}; VAD silence ${vadSilenceMs} ms; ${tracks.length} clips, ${(stream.length / RATE).toFixed(1)} s of audio\n`);

// ---- Real-time streaming loop (drift-corrected) ----
const t0 = performance.now();
for (let i = 0; i < stream.length; i += CHUNK) {
  const target = t0 + (i / RATE) * 1000;
  const wait = target - performance.now();
  if (wait > 1) await sleep(wait);
  const chunk = stream.subarray(i, i + CHUNK);
  session.sendRealtimeInput({ audio: { data: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'), mimeType: `audio/pcm;rate=${RATE}` } });
  const sentEnd = i + CHUNK;
  for (const t of tracks) {
    if (t.speechStartAt === undefined && sentEnd >= t.speechStartSample) t.speechStartAt = performance.now();
    if (t.speechEndAt === undefined && sentEnd >= t.speechEndSample) t.speechEndAt = performance.now();
  }
}
session.sendRealtimeInput({ audioStreamEnd: true });
await sleep(4000);
session.close();

// ---- Report ----
const rel = (a?: number, b?: number) => (a !== undefined && b !== undefined ? a - b : Number.NaN);
const results = tracks.map((t) => ({
  id: t.clip.id,
  firstInterimMs: rel(t.firstInterimAt, t.speechStartAt),
  interimUpdates: t.interimCount,
  endpointMs: rel(t.activityEndAt, t.speechEndAt),
  finalMs: rel(t.finishedAt ?? t.lastFinalAt, t.speechEndAt),
  wer: t.clip.text ? wordErrorRate(t.clip.text, t.finalText) : Number.NaN,
  interimWer: t.clip.text && t.lastInterim ? wordErrorRate(t.clip.text, t.lastInterim) : Number.NaN,
  reference: t.clip.text,
  transcript: t.finalText.trim(),
}));

console.log(
  table(
    ['clip', '1st interim', 'interim upd', 'VAD end', 'final', 'WER', 'transcript'],
    results.map((r) => [r.id, fmtMs(r.firstInterimMs), r.interimUpdates, fmtMs(r.endpointMs), fmtMs(r.finalMs), Number.isFinite(r.wer) ? `${(r.wer * 100).toFixed(0)}%` : '—', r.transcript.slice(0, 60)]),
  ),
);
const col = (k: 'firstInterimMs' | 'endpointMs' | 'finalMs') => results.map((r) => r[k]);
console.log(`\nfirst interim  p50 ${fmtMs(percentile(col('firstInterimMs'), 50))}  p95 ${fmtMs(percentile(col('firstInterimMs'), 95))}`);
console.log(`VAD end delay  p50 ${fmtMs(percentile(col('endpointMs'), 50))}  p95 ${fmtMs(percentile(col('endpointMs'), 95))}`);
console.log(`final text     p50 ${fmtMs(percentile(col('finalMs'), 50))}  p95 ${fmtMs(percentile(col('finalMs'), 95))}`);
console.log(`mean WER ${(mean(results.map((r) => r.wer)) * 100).toFixed(1)}%   tokens in/out ${inputTokens}/${outputTokens}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = new URL('../results/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL(`stt-latency-${stamp}.json`, dir), JSON.stringify({ model: used, vadSilenceMs, results, inputTokens, outputTokens }, null, 2));
console.log(`\nSaved spikes/results/stt-latency-${stamp}.json`);
