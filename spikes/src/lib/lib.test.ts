import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, decodeWav, encodeWav, resample, silence, speechBounds } from './wav.ts';
import { percentile } from './stats.ts';
import { wordErrorRate } from './text.ts';
import { redact } from './env.ts';

test('WAV encode/decode round-trips samples', () => {
  const samples = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
  const out = decodeWav(encodeWav({ sampleRate: 16000, samples }));
  assert.equal(out.sampleRate, 16000);
  assert.deepEqual(Array.from(out.samples), Array.from(samples));
});

test('resample 24k -> 16k keeps duration', () => {
  const src = { sampleRate: 24000, samples: new Int16Array(24000) };
  const dst = resample(src, 16000);
  assert.equal(dst.sampleRate, 16000);
  assert.equal(dst.samples.length, 16000);
});

test('speechBounds finds the loud region', () => {
  const loud = new Int16Array(1600).fill(8000);
  const audio = { sampleRate: 16000, samples: concat(silence(16000, 500), loud, silence(16000, 500)) };
  const b = speechBounds(audio);
  assert.ok(b);
  assert.equal(b.start, 8000);
  assert.equal(b.end, 9600);
});

test('percentile (nearest rank)', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test('WER counts substitutions, insertions, deletions', () => {
  assert.equal(wordErrorRate('Tell me about yourself.', 'tell me about yourself'), 0);
  assert.equal(wordErrorRate('a b c d', 'a x c d'), 0.25);
  assert.equal(wordErrorRate('a b c d', 'a b c'), 0.25);
  assert.equal(wordErrorRate('a b', 'a b c d'), 1);
});

test('redact hides API keys', () => {
  const fake = ['AI', 'za', 'Sy', 'X'.repeat(33)].join(''); // built at runtime so secret scanners don't flag the repo
  const s = redact(`failed for key=${fake} and ${fake}`);
  assert.ok(!s.includes(fake));
});
