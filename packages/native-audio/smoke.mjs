/* eslint-disable no-console */
// Smoke test for the native audio module.
//   node smoke.mjs                 → test-tone plumbing (+ Windows: 5 s of mic + system audio)
//   node smoke.mjs --seconds 30    → longer Windows capture (try unplugging a headset meanwhile)
//   node smoke.mjs --pid 1234      → also per-app loopback of that process (Windows)
//   node smoke.mjs --app zoom      → per-app loopback of the first app from listAudioApps() matching "zoom"
// Windows recordings are written to ./recordings as 16 kHz mono WAVs.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const native = createRequire(import.meta.url)('./aic_native_audio.node');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const seconds = Number(arg('seconds') ?? 5);
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

function capture(options, ms, { withEvents = true, label = options.source } = {}) {
  return new Promise((resolve) => {
    const frames = [];
    const events = [];
    let error;
    let runningWhileCapturing;
    const onFrame = (f) => frames.push(f);
    const onError = (m) => {
      error = m;
    };
    const onEvent = (e) => {
      events.push(e);
      console.log(`  [${label}] ${e.kind}: ${e.message}`);
    };
    const session = withEvents
      ? native.startCapture(options, onFrame, onError, onEvent)
      : native.startCapture(options, onFrame, onError);
    setTimeout(() => {
      runningWhileCapturing = session.running;
      session.stop();
      const runningAfterStop = session.running;
      setTimeout(
        () => resolve({ frames, events, error, runningWhileCapturing, runningAfterStop }),
        50,
      );
    }, ms);
  });
}

function stats({ frames, error }, ms) {
  const gaps = frames.slice(1).map((f, i) => f.timestampMs - frames[i].timestampMs);
  const contiguous = frames.every((f, i) => f.seq === i);
  const sizesOk = frames.every((f) => f.pcm.length === 640);
  let peak = 0;
  for (const f of frames)
    for (let i = 0; i < f.pcm.length; i += 2) peak = Math.max(peak, Math.abs(f.pcm.readInt16LE(i)));
  return {
    error,
    frames: frames.length,
    expected: Math.round(ms / 20),
    contiguous,
    sizesOk,
    maxGapMs: gaps.length ? Math.max(...gaps) : 0,
    filled: frames.filter((f) => f.filled).length,
    discontinuities: frames.filter((f) => f.discontinuity).length,
    peakDbfs: peak ? +(20 * Math.log10(peak / 32768)).toFixed(1) : -Infinity,
  };
}

function wav(frames) {
  const pcm = Buffer.concat(frames.map((f) => f.pcm));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

console.log(`platform ${process.platform}, sources: ${native.supportedSources().join(', ')}`);
const t0 = native.nowMs();
check(typeof t0 === 'number' && t0 >= 0, `nowMs() returns a number (${t0.toFixed(1)})`);

// 1) JS plumbing with the synthetic tone (all platforms)
const toneRun = await capture({ source: 'test-tone', channel: 'test' }, 1000);
const tone = stats(toneRun, 1000);
console.log(tone);
check(!tone.error, 'test-tone: no error');
check(tone.frames >= 45 && tone.frames <= 52, `test-tone: ~50 frames in 1 s (got ${tone.frames})`);
check(tone.contiguous && tone.sizesOk, 'test-tone: contiguous seq, 640-byte frames');
check(
  tone.maxGapMs < 60,
  `test-tone: max gap between frames < 60 ms (got ${tone.maxGapMs.toFixed(1)})`,
);
check(Math.abs(tone.peakDbfs - -12) < 0.5, `test-tone: peak ≈ -12 dBFS (got ${tone.peakDbfs})`);
check(
  toneRun.frames.every((f) => f.channel === 'test' && !f.filled && !f.discontinuity),
  'test-tone: channel label echoed, no filled/discontinuity frames',
);
const opened = toneRun.events.filter((e) => e.kind === 'opened');
check(
  toneRun.events.length === 1 && opened.length === 1,
  `test-tone: exactly one "opened" event (got ${toneRun.events.map((e) => e.kind).join(', ') || 'none'})`,
);
const o = opened[0] ?? {};
check(
  o.device === 'Test tone' &&
    o.sampleRate === 16000 &&
    o.channels === 1 &&
    o.sampleFormat === 'i16' &&
    o.windowsConverts === false,
  `test-tone: "opened" event has the format details (${JSON.stringify(o)})`,
);
check(
  toneRun.runningWhileCapturing === true && toneRun.runningAfterStop === false,
  'session.running is true while capturing and false after stop()',
);

const noEvents = await capture({ source: 'test-tone', channel: 'test' }, 200, {
  withEvents: false,
});
check(
  !noEvents.error && noEvents.frames.length >= 5,
  `startCapture works without onEvent (${noEvents.frames.length} frames)`,
);

const bad = await capture({ source: 'nope', channel: 'x' }, 100);
check(Boolean(bad.error), `unknown source reports an error ("${bad.error}")`);
check(bad.runningAfterStop === false, 'session with a fatal error is not running');
const noPid = await capture({ source: 'process', channel: 'x' }, 100);
check(Boolean(noPid.error), `process capture without a pid reports an error ("${noPid.error}")`);

let apps = [];
try {
  apps = native.listAudioApps();
  check(Array.isArray(apps), `listAudioApps() returns an array (${apps.length} apps)`);
} catch (err) {
  // A machine without the audio service (e.g. a CI runner) may fail here.
  check(process.platform === 'win32', `listAudioApps() threw: ${err.message}`);
}
if (process.platform !== 'win32') check(apps.length === 0, 'listAudioApps() is empty off Windows');

// 2) Real devices (Windows)
if (process.platform === 'win32') {
  let devices = [];
  try {
    devices = native.listDevices();
  } catch (err) {
    console.log(`listDevices failed (no audio service, e.g. a CI runner?): ${err.message}`);
  }
  console.table(devices.map(({ name, kind, isDefault }) => ({ name, kind, isDefault })));
  console.table(apps);

  const wanted = arg('app')?.toLowerCase();
  const app = wanted
    ? apps.find((a) => `${a.name} ${a.displayName}`.toLowerCase().includes(wanted))
    : undefined;
  if (wanted && !app) console.log(`No audio app matches "${wanted}".`);
  const pid = arg('pid') ? Number(arg('pid')) : app?.pid;
  const targets = [
    { source: 'microphone', channel: 'candidate' },
    { source: 'system', channel: 'interviewer' },
    ...(pid ? [{ source: 'process', channel: 'app', processId: pid }] : []),
  ];
  if (!devices.length)
    console.log('No audio endpoints (e.g. a CI runner) — skipping device capture.');
  else {
    mkdirSync(new URL('./recordings/', import.meta.url), { recursive: true });
    console.log(
      `Capturing ${targets.map((t) => t.source).join(' + ')} for ${seconds} s — play some audio and talk…`,
    );
    const results = await Promise.all(targets.map((t) => capture(t, seconds * 1000)));
    results.forEach((r, i) => {
      const t = targets[i];
      const s = stats(r, seconds * 1000);
      console.log(t.source, s);
      check(!s.error, `${t.source}: no error`);
      check(
        r.events[0]?.kind === 'opened',
        `${t.source}: first event is "opened" (${r.events[0]?.message ?? 'none'})`,
      );
      check(s.contiguous && s.sizesOk, `${t.source}: contiguous seq, 640-byte frames`);
      check(
        s.frames >= s.expected * 0.95,
        `${t.source}: ≥95% of expected frames (${s.frames}/${s.expected})`,
      );
      if (r.frames.length)
        writeFileSync(new URL(`./recordings/${t.source}.wav`, import.meta.url), wav(r.frames));
    });
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
