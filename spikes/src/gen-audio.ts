/**
 * Phase 0 — generates synthetic interviewer audio fixtures with Gemini TTS.
 * Each clip: 600 ms lead silence + speech + 2000 ms trailing silence, 16 kHz mono PCM16.
 * Output: spikes/fixtures/audio/<id>.wav + manifest.json (git-ignored, regenerable).
 *
 * Usage: npm run gen-audio -- [--model <tts-model>] [--force]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Modality } from '@google/genai';
import { createClient, errorMessage, parseArgs, sleep } from './lib/env.ts';
import { concat, decodeWav, pcm16FromBytes, resample, silence, speechBounds, writeWav } from './lib/wav.ts';
import { loadQuestions } from './prompt.ts';
import { byNewest, listModels } from './models.ts';

export interface Clip {
  id: string;
  kind: string;
  text: string;
  file: string;
  voice: string;
  sampleRate: number;
  durationMs: number;
  speechStartMs: number;
  speechEndMs: number;
}

export const AUDIO_DIR = new URL('../fixtures/audio/', import.meta.url);
export const loadManifest = (): Clip[] => JSON.parse(readFileSync(new URL('manifest.json', AUDIO_DIR), 'utf8')) as Clip[];

const RATE = 16000;
const LEAD_MS = 600;
const TRAIL_MS = 2000;
const VOICES = ['Kore', 'Puck', 'Charon', 'Aoede'];

if (import.meta.main) {
  const args = parseArgs();
  const ai = createClient();
  const ttsModels = byNewest((await listModels()).filter((m) => m.tags.includes('tts')).map((m) => m.name));
  const model = args.get('model') ?? ttsModels.find((n) => n.includes('flash') && !n.includes('lite')) ?? ttsModels[0];
  if (!model) {
    console.error('No TTS model available to this key. Pass --model explicitly (see `npm run models`).');
    process.exit(1);
  }
  mkdirSync(AUDIO_DIR, { recursive: true });
  const existing: Clip[] = existsSync(new URL('manifest.json', AUDIO_DIR)) ? loadManifest() : [];
  const manifest: Clip[] = [];
  console.log(`TTS model: ${model}`);

  const questions = loadQuestions();
  for (const [i, q] of questions.entries()) {
    const file = `${q.id}.wav`;
    const prior = existing.find((c) => c.id === q.id && c.text === q.text);
    if (prior && !args.has('force') && existsSync(new URL(file, AUDIO_DIR))) {
      manifest.push(prior);
      continue;
    }
    const voice = VOICES[i % VOICES.length]!;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model,
          // Plain text only: style prefixes ("Say naturally: …") get read aloud by some TTS models.
          contents: [{ role: 'user', parts: [{ text: q.text }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        });
        const inline = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
        if (!inline?.data) throw new Error('TTS returned no audio');
        const bytes = Buffer.from(inline.data, 'base64');
        const mime = inline.mimeType ?? '';
        const decoded = /wav/i.test(mime)
          ? decodeWav(bytes)
          : { sampleRate: Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000), samples: pcm16FromBytes(bytes) };
        const audio = resample(decoded, RATE);
        const b = speechBounds(audio) ?? { start: 0, end: audio.samples.length };
        const speech = audio.samples.slice(b.start, b.end);
        const samples = concat(silence(RATE, LEAD_MS), speech, silence(RATE, TRAIL_MS));
        writeWav(new URL(file, AUDIO_DIR).pathname, { sampleRate: RATE, samples });
        const clip: Clip = {
          id: q.id, kind: q.kind, text: q.text, file, voice, sampleRate: RATE,
          durationMs: Math.round((samples.length / RATE) * 1000),
          speechStartMs: LEAD_MS,
          speechEndMs: LEAD_MS + Math.round((speech.length / RATE) * 1000),
        };
        manifest.push(clip);
        console.log(`  ${q.id} (${voice}) ${(clip.speechEndMs - clip.speechStartMs) / 1000}s`);
        break;
      } catch (err) {
        const msg = errorMessage(err);
        if (attempt < 5 && /\b(429|500|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(msg)) {
          const wait = 15000 * (attempt + 1);
          console.log(`  ${q.id}: rate-limited/unavailable, retrying in ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
        console.error(`  ${q.id}: failed — ${msg}`);
        break;
      }
    }
  }
  writeFileSync(new URL('manifest.json', AUDIO_DIR), JSON.stringify(manifest, null, 2));
  console.log(`\n${manifest.length}/${questions.length} clips ready in spikes/fixtures/audio/`);
}
