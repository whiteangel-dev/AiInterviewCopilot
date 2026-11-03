// Smoke test for the native audio module.
//   node smoke.mjs                 → test-tone plumbing (+ Windows: 5 s of mic + system audio)
//   node smoke.mjs --seconds 30    → longer Windows capture
//   node smoke.mjs --pid 1234      → also per-app loopback of that process (Windows)
// Windows recordings are written to ./recordings as 16 kHz mono WAVs.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const native = createRequire(import.meta.url)('./aic_native_audio.node');
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const seconds = Number(arg('seconds') ?? 5);
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

function capture(options, ms) {
  return new Promise((resolve) => {
    const frames = [];
    let error;
    const session = native.startCapture(options, (f) => frames.push(f), (m) => { error = m; });
    setTimeout(() => { session.stop(); setTimeout(() => resolve({ frames, error }), 50); }, ms);
  });
}

function stats({ frames, error }, ms) {
  const gaps = frames.slice(1).map((f, i) => f.timestampMs - frames[i].timestampMs);
  const contiguous = frames.every((f, i) => f.seq === i);
  const sizesOk = frames.every((f) => f.pcm.length === 640);
  let peak = 0;
  for (const f of frames) for (let i = 0; i < f.pcm.length; i += 2) peak = Math.max(peak, Math.abs(f.pcm.readInt16LE(i)));
  return {
    error, frames: frames.length, expected: Math.round(ms / 20), contiguous, sizesOk,
    maxGapMs: gaps.length ? Math.max(...gaps) : 0,
    filled: frames.filter((f) => f.filled).length, discontinuities: frames.filter((f) => f.discontinuity).length,
    peakDbfs: peak ? +(20 * Math.log10(peak / 32768)).toFixed(1) : -Infinity,
  };
}

function wav(frames) {
  const pcm = Buffer.concat(frames.map((f) => f.pcm));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

console.log(`platform ${process.platform}, sources: ${native.supportedSources().join(', ')}`);

// 1) JS plumbing with the synthetic tone (all platforms)
const tone = stats(await capture({ source: 'test-tone', channel: 'test' }, 1000), 1000);
console.log(tone);
check(!tone.error, 'test-tone: no error');
check(tone.frames >= 45 && tone.frames <= 52, `test-tone: ~50 frames in 1 s (got ${tone.frames})`);
check(tone.contiguous && tone.sizesOk, 'test-tone: contiguous seq, 640-byte frames');
check(tone.maxGapMs < 60, `test-tone: max gap between frames < 60 ms (got ${tone.maxGapMs.toFixed(1)})`);
check(Math.abs(tone.peakDbfs - -12) < 0.5, `test-tone: peak ≈ -12 dBFS (got ${tone.peakDbfs})`);
const bad = await capture({ source: 'nope', channel: 'x' }, 100);
check(Boolean(bad.error), `unknown source reports an error ("${bad.error}")`);

// 2) Real devices (Windows)
if (process.platform === 'win32') {
  let devices = [];
  try {
    devices = native.listDevices();
  } catch (err) {
    console.log(`listDevices failed (no audio service, e.g. a CI runner?): ${err.message}`);
  }
  console.table(devices.map(({ name, kind, isDefault }) => ({ name, kind, isDefault })));
  const targets = [
    { source: 'microphone', channel: 'candidate' },
    { source: 'system', channel: 'interviewer' },
    ...(arg('pid') ? [{ source: 'process', channel: 'app', processId: Number(arg('pid')) }] : []),
  ];
  if (!devices.length) console.log('No audio endpoints (e.g. a CI runner) — skipping device capture.');
  else {
    mkdirSync(new URL('./recordings/', import.meta.url), { recursive: true });
    console.log(`Capturing ${targets.map((t) => t.source).join(' + ')} for ${seconds} s — play some audio and talk…`);
    const results = await Promise.all(targets.map((t) => capture(t, seconds * 1000)));
    results.forEach((r, i) => {
      const t = targets[i];
      const s = stats(r, seconds * 1000);
      console.log(t.source, s);
      check(!s.error, `${t.source}: no error`);
      check(s.frames >= s.expected * 0.95, `${t.source}: ≥95% of expected frames (${s.frames}/${s.expected})`);
      if (r.frames.length) writeFileSync(new URL(`./recordings/${t.source}.wav`, import.meta.url), wav(r.frames));
    });
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
