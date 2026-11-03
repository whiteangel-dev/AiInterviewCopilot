/**
 * Phase 0 — end-to-end latency prototype.
 *
 * Streams interviewer audio in real time and runs the planned live pipeline:
 *   local VAD (pause ≥ 300 ms) → Gemini Live transcript (interim) →
 *   turn analyzer ∥ speculative answer stream → first answer word "on screen".
 * The answer is shown only once the analyzer confirms "answer"; it is cancelled on
 * "wait"/"ignore" or if the interviewer resumes. At 1.2 s of silence the analyzer is
 * asked again with a "silent for over a second" hint (fallback path).
 *
 * Measures: interviewer's last word → first answer word displayed.
 *
 * Usage: npm run e2e -- [--clips q02,q05] [--answer-model m] [--analyzer-model m] [--pause 300]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ActivityHandling, EndSensitivity, Modality, StartSensitivity, ThinkingLevel } from '@google/genai';
import type { Content, GenerateContentConfig, GenerateContentResponse, LiveServerMessage, Session } from '@google/genai';
import { createClient, errorMessage, parseArgs, sleep } from './lib/env.ts';
import { fmtMs, percentile, table } from './lib/stats.ts';
import { wordErrorRate } from './lib/text.ts';
import { concat, readWav, silence } from './lib/wav.ts';
import { AUDIO_DIR, loadManifest } from './gen-audio.ts';
import type { Clip } from './gen-audio.ts';
import { buildSystemInstruction, KEY_TERMS } from './prompt.ts';
import { ANALYZER_SCHEMA, ANALYZER_SYSTEM, analyzerUserText } from './analyzer.ts';

const args = parseArgs();
const RATE = 16000;
const CHUNK = 320; // 20 ms
const GAP_MS = 1000;
const PAUSE_MS = Number(args.get('pause') ?? 300);
const FALLBACK_MS = 1200;
const VOICE_RMS = 400;
const sttModel = args.get('stt-model') ?? 'gemini-3.5-transcribe-live';
const answerModel = args.get('answer-model') ?? 'gemini-3.5-flash-lite';
const analyzerModel = args.get('analyzer-model') ?? answerModel;
const thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
const ai = createClient();
const systemInstruction = buildSystemInstruction();

// ---- Audio plan ----
interface Attempt {
  ac: AbortController;
  startedAt: number;
  fallback: boolean;
  confirmed: boolean;
  decidedAt?: number;
  firstTokenAt?: number;
  text: string;
}
interface ClipState {
  clip: Clip;
  startSample: number;
  speechEndSample: number;
  speechStartAt?: number;
  speechEndAt?: number;
  finals: string;
  interim: string;
  attempts: number;
  cancelled: number;
  prematureDisplays: number;
  active?: Attempt;
  outcome?: 'answered' | 'ignored';
  path?: 'analyzer' | 'fallback' | 'question-mark';
  displayedAt?: number;
  analyzerMs?: number;
  ttftMs?: number;
  transcriptAtTrigger?: string;
  /** Diagnostics: every attempt, with ms relative to the true end of speech. */
  triggers: { ms: number; reason: string; text: string }[];
}

const only = args.get('clips')?.split(',');
const clips = loadManifest().filter((c) => !only || only.includes(c.id));
const states: ClipState[] = [];
const parts: Int16Array[] = [];
let offset = 0;
for (const clip of clips) {
  const s = readWav(new URL(clip.file, AUDIO_DIR).pathname).samples;
  states.push({
    clip, startSample: offset, speechEndSample: offset + Math.round((clip.speechEndMs / 1000) * RATE),
    finals: '', interim: '', attempts: 0, cancelled: 0, prematureDisplays: 0, triggers: [],
  });
  parts.push(s, silence(RATE, GAP_MS));
  offset += s.length + Math.round((GAP_MS / 1000) * RATE);
}
const stream = concat(...parts);
const answeredHistory: string[] = [];

// ---- Pipeline ----
const visible = (c: GenerateContentResponse) =>
  c.candidates?.[0]?.content?.parts?.map((p) => (p.thought ? '' : (p.text ?? ''))).join('') ?? '';
const transcriptOf = (cs: ClipState) => (cs.interim.length >= cs.finals.trim().length ? cs.interim : cs.finals.trim());

function answerContents(text: string): Content[] {
  const history = answeredHistory.slice(-3).map((q) => `Interviewer: ${q}`).join('\n') || '(start of interview)';
  return [{ role: 'user', parts: [{ text: `INTERVIEW SO FAR\n${history}\n\nINTERVIEWER'S LATEST TURN\n${text}` }] }];
}

function maybeDisplay(cs: ClipState, att: Attempt) {
  if (cs.active !== att || !att.confirmed || att.firstTokenAt === undefined || cs.displayedAt !== undefined) return;
  cs.displayedAt = performance.now();
  cs.ttftMs = att.firstTokenAt - att.startedAt;
  cs.outcome = 'answered';
}

function decide(cs: ClipState, att: Attempt, action: string) {
  if (cs.active !== att) return; // superseded
  cs.analyzerMs = (att.decidedAt ?? performance.now()) - att.startedAt;
  if (action === 'answer') {
    if (!att.confirmed) cs.path = att.fallback ? 'fallback' : 'analyzer';
    att.confirmed = true;
    maybeDisplay(cs, att);
  } else {
    // Retract a fast-path answer the analyzer disagrees with.
    if (cs.displayedAt !== undefined) cs.prematureDisplays++;
    cs.displayedAt = undefined;
    cs.outcome = undefined;
    cs.path = undefined;
    att.ac.abort();
    cs.active = undefined;
    if (action === 'ignore') cs.outcome = 'ignored';
    else cs.cancelled++;
  }
}

let lastTriggerText = '';
/**
 * Starts (or restarts) an attempt: analyzer ∥ speculative answer on the current transcript.
 * reason: 'pause' (local VAD 300 ms), 'update' (transcript grew during a pause), 'fallback' (1.2 s).
 */
function onPause(cs: ClipState, reason: 'pause' | 'update' | 'fallback') {
  const fallback = reason === 'fallback';
  if (cs.outcome || cs.active?.confirmed) return;
  if (reason === 'pause' && cs.active) return;
  const text = transcriptOf(cs);
  if (!text || (reason === 'update' && text === lastTriggerText)) return;
  lastTriggerText = text;
  if (cs.active) {
    cs.active.ac.abort();
    cs.cancelled++;
  }
  const att: Attempt = { ac: new AbortController(), startedAt: performance.now(), fallback, confirmed: false, text: '' };
  cs.active = att;
  cs.attempts++;
  cs.transcriptAtTrigger = text;
  cs.triggers.push({ ms: Math.round(att.startedAt - (cs.speechEndAt ?? att.startedAt)), reason, text });
  // Fast path: a transcript ending in "?" is shown as soon as the answer streams;
  // the analyzer still runs and can retract it.
  if (/\?\s*$/.test(text)) {
    att.confirmed = true;
    cs.path = 'question-mark';
  }

  // Speculative answer, in parallel with the analyzer.
  void (async () => {
    const s = await ai.models.generateContentStream({
      model: answerModel, contents: answerContents(text),
      config: { systemInstruction, maxOutputTokens: 1024, thinkingConfig, abortSignal: att.ac.signal },
    });
    for await (const chunk of s) {
      const t = visible(chunk);
      if (!t) continue;
      att.firstTokenAt ??= performance.now();
      att.text += t;
      maybeDisplay(cs, att);
    }
  })().catch((err) => { if (!att.ac.signal.aborted) console.error(`answer ${cs.clip.id}: ${errorMessage(err)}`); });

  void (async () => {
    const prev = answeredHistory.at(-1);
    const hint = fallback ? '\n\n(The interviewer has now been silent for over a second.)' : '';
    const s = await ai.models.generateContentStream({
      model: analyzerModel, contents: analyzerUserText(text, prev ? { question: prev } : undefined) + hint,
      config: { systemInstruction: ANALYZER_SYSTEM, responseMimeType: 'application/json', responseJsonSchema: ANALYZER_SCHEMA, maxOutputTokens: 300, thinkingConfig, abortSignal: att.ac.signal },
    });
    let json = '';
    for await (const chunk of s) {
      json += visible(chunk);
      const m = /"action"\s*:\s*"(answer|ignore|wait)"/.exec(json);
      if (m && att.decidedAt === undefined) {
        att.decidedAt = performance.now();
        decide(cs, att, m[1]!);
      }
    }
  })().catch((err) => { if (!att.ac.signal.aborted) console.error(`analyzer ${cs.clip.id}: ${errorMessage(err)}`); });
}

function onResume(cs: ClipState) {
  if (cs.active) {
    cs.active.ac.abort();
    cs.active = undefined;
    cs.cancelled++;
  }
  if (cs.displayedAt !== undefined) cs.prematureDisplays++;
  cs.displayedAt = undefined;
  cs.outcome = undefined;
  cs.path = undefined;
}

// ---- Live transcription ----
const currentSpoken = () => [...states].reverse().find((s) => s.speechStartAt !== undefined);
let clipIdx = -1;
let pauseActive = false; // local VAD: interviewer silent ≥ PAUSE_MS in the current clip
function onMessage(msg: LiveServerMessage) {
  const cs = currentSpoken();
  const sc = msg.serverContent;
  if (!cs || !sc) return;
  if (sc.interimInputTranscription?.text) cs.interim = sc.interimInputTranscription.text;
  if (sc.inputTranscription?.text) cs.finals += sc.inputTranscription.text;
  // The transcript often catches up after the pause began: re-evaluate on every update.
  if (pauseActive && cs === states[clipIdx]) onPause(cs, 'update');
}

let ready: () => void = () => {};
const setup = new Promise<void>((r) => { ready = r; });
const session: Session = await ai.live.connect({
  model: sttModel,
  config: {
    responseModalities: [Modality.TEXT],
    systemInstruction: 'You are a silent transcription relay. Never answer or comment. If a reply is required, reply with a single period.',
    inputAudioTranscription: { languageCodes: ['en-US'], customVocabulary: KEY_TERMS },
    realtimeInputConfig: {
      automaticActivityDetection: { silenceDurationMs: PAUSE_MS, startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH, endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH },
      activityHandling: ActivityHandling.NO_INTERRUPTION,
    },
  },
  callbacks: {
    onmessage: (m) => { if (m.setupComplete) ready(); onMessage(m); },
    onerror: (e) => console.error(`live error: ${errorMessage(e.message)}`),
    onclose: (e) => { if (e.code !== 1000) console.error(`live closed ${e.code}: ${errorMessage(e.reason)}`); },
  },
});
await Promise.race([setup, sleep(10000).then(() => { throw new Error('Live setup timeout'); })]);
console.log(`STT ${sttModel} · analyzer ${analyzerModel} · answer ${answerModel} · pause ${PAUSE_MS} ms · ${states.length} clips\n`);

// ---- Real-time streaming with local VAD ----
const pauseChunks = PAUSE_MS / 20;
const fallbackChunks = FALLBACK_MS / 20;
let heardVoice = false;
let silentChunks = 0;
const t0 = performance.now();
for (let i = 0; i < stream.length; i += CHUNK) {
  const wait = t0 + (i / RATE) * 1000 - performance.now();
  if (wait > 1) await sleep(wait);
  const chunk = stream.subarray(i, i + CHUNK);
  session.sendRealtimeInput({ audio: { data: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'), mimeType: `audio/pcm;rate=${RATE}` } });

  const idx = states.findLastIndex((s) => s.startSample <= i);
  if (idx !== clipIdx) {
    clipIdx = idx;
    heardVoice = false;
    silentChunks = 0;
    pauseActive = false;
  }
  const cs = states[clipIdx]!;
  if (cs.speechEndAt === undefined && i + CHUNK >= cs.speechEndSample) cs.speechEndAt = performance.now();

  let sum = 0;
  for (let k = 0; k < chunk.length; k++) sum += (chunk[k] ?? 0) * (chunk[k] ?? 0);
  if (Math.sqrt(sum / chunk.length) >= VOICE_RMS) {
    if (!heardVoice) cs.speechStartAt ??= performance.now();
    if (heardVoice && silentChunks >= pauseChunks) onResume(cs);
    heardVoice = true;
    silentChunks = 0;
    pauseActive = false;
  } else if (heardVoice) {
    silentChunks++;
    if (silentChunks === pauseChunks) {
      pauseActive = true;
      onPause(cs, 'pause');
    }
    if (silentChunks === fallbackChunks && !cs.outcome && !cs.active) onPause(cs, 'fallback');
  }
  if (cs.outcome === 'answered' && !answeredHistory.includes(cs.transcriptAtTrigger ?? '') && silentChunks > fallbackChunks) {
    answeredHistory.push(cs.transcriptAtTrigger ?? '');
  }
}
await sleep(4000);
session.close();
for (const s of states) s.active?.ac.abort();

// ---- Report ----
const rows = states.map((s) => ({
  id: s.clip.id,
  expected: s.clip.kind === 'skip' ? 'ignore' : 'answer',
  outcome: s.outcome ?? 'missed',
  path: s.path ?? '',
  e2eMs: s.displayedAt !== undefined && s.speechEndAt !== undefined ? s.displayedAt - s.speechEndAt : Number.NaN,
  analyzerMs: s.analyzerMs ?? Number.NaN,
  ttftMs: s.ttftMs ?? Number.NaN,
  attempts: s.attempts,
  cancelled: s.cancelled,
  prematureDisplays: s.prematureDisplays,
  wer: s.transcriptAtTrigger ? wordErrorRate(s.clip.text, s.transcriptAtTrigger) : Number.NaN,
  triggers: s.triggers.map((t) => `${t.reason}@${t.ms}`).join(' '),
  transcript: s.transcriptAtTrigger ?? '',
}));
console.log(
  table(
    ['clip', 'expect', 'outcome', 'path', 'last word → answer', 'analyzer', 'answer TTFT', 'attempts', 'cancelled', 'premature shown', 'WER', 'attempt starts (ms after last word)'],
    rows.map((r) => [r.id, r.expected, r.outcome, r.path, fmtMs(r.e2eMs), fmtMs(r.analyzerMs), fmtMs(r.ttftMs), r.attempts, r.cancelled, r.prematureDisplays, Number.isFinite(r.wer) ? `${Math.round(r.wer * 100)}%` : '—', r.triggers]),
  ),
);
const answered = rows.filter((r) => r.outcome === 'answered' && r.expected === 'answer');
const correct = rows.filter((r) => (r.expected === 'answer' ? r.outcome === 'answered' : r.outcome !== 'answered')).length;
const e2e = answered.map((r) => r.e2eMs);
console.log(`\nlast word → first answer word: p50 ${fmtMs(percentile(e2e, 50))} · p95 ${fmtMs(percentile(e2e, 95))} · max ${fmtMs(Math.max(...e2e))}`);
console.log(`correct outcome ${correct}/${rows.length} · premature answers shown ${rows.reduce((a, r) => a + r.prematureDisplays, 0)} · LLM attempts ${rows.reduce((a, r) => a + r.attempts, 0)} (${rows.reduce((a, r) => a + r.cancelled, 0)} cancelled)`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../results/e2e-${stamp}.json`, import.meta.url), JSON.stringify({ sttModel, analyzerModel, answerModel, PAUSE_MS, rows }, null, 2));
console.log(`\nSaved spikes/results/e2e-${stamp}.json`);
