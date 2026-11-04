import { describe, expect, it } from 'vitest';
import { EchoCanceller } from './aec';
import { FFT } from './fft';

const RATE = 16_000;
const FRAME = 320;

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/** Speech-like: colored noise with a syllable-rate envelope and pauses, as floats in [-1, 1]. */
function speechLike(seconds: number, seed: number, level = 0.25): Float64Array {
  const r = rng(seed);
  const out = new Float64Array(seconds * RATE);
  let a = 0;
  let b = 0;
  for (let i = 0; i < out.length; i++) {
    a = 0.6 * a + r();
    b = 0.5 * b + a;
    const t = i / RATE;
    const envelope = Math.max(0, Math.sin(2 * Math.PI * 3.3 * t + seed)) ** 0.5;
    out[i] = level * b * envelope;
  }
  return out;
}

/** A room: a direct path after `delayMs` plus a decaying tail, at `gain`. */
function echoPath(delayMs: number, gain: number): Float64Array {
  const r = rng(7);
  const d = Math.round((delayMs * RATE) / 1000);
  const h = new Float64Array(d + 1600);
  h[d] = gain;
  for (let i = 1; i < 1600; i++) h[d + i] = gain * 0.2 * r() * Math.exp(-i / 300);
  return h;
}

function convolve(x: Float64Array, h: Float64Array): Float64Array {
  const y = new Float64Array(x.length);
  const taps: number[] = [];
  for (let k = 0; k < h.length; k++) if (h[k] !== 0) taps.push(k);
  for (let n = 0; n < x.length; n++) {
    let s = 0;
    for (const k of taps) if (n - k >= 0) s += h[k]! * x[n - k]!;
    y[n] = s;
  }
  return y;
}

const toPcm = (x: Float64Array, from: number) => {
  const f = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++)
    f[i] = Math.round(Math.max(-1, Math.min(1, x[from + i] ?? 0)) * 32_767);
  return f;
};

/** Runs reference and microphone through the canceller; returns the output as floats. */
function run(aec: EchoCanceller, reference: Float64Array, mic: Float64Array, refLagFrames = 0) {
  const out: number[] = [];
  const frames = Math.floor(mic.length / FRAME);
  const refQueue: Int16Array[] = [];
  for (let f = 0; f < frames; f++) {
    refQueue.push(toPcm(reference, f * FRAME));
    // The reference can arrive a little after the microphone (separate capture threads).
    while (refQueue.length > refLagFrames) aec.reference(refQueue.shift()!);
    for (const o of aec.process(toPcm(mic, f * FRAME))) for (const v of o) out.push(v / 32_768);
  }
  return Float64Array.from(out);
}

const power = (x: Float64Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return s / Math.max(1, to - from);
};
const db = (a: number, b: number) => 10 * Math.log10(a / b);

/** Correlation of a with b shifted by `lag` samples (a lags b). */
function correlation(a: Float64Array, b: Float64Array, from: number, to: number, lag: number) {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = from; i < to; i++) {
    const x = a[i]!;
    const y = b[i - lag] ?? 0;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return ab / Math.sqrt(aa * bb);
}

/** The output is delayed by the lookahead (64 ms) plus buffering; find it. */
function bestLag(out: Float64Array, ref: Float64Array, from: number, to: number) {
  let best = { lag: 0, c: -1 };
  for (let lag = 0; lag < 3200; lag += 16) {
    const c = correlation(out, ref, from, to, lag);
    if (c > best.c) best = { lag, c };
  }
  return best;
}

describe('FFT', () => {
  it('round-trips and matches a direct DFT', () => {
    const fft = new FFT(16);
    const re = Float64Array.from({ length: 16 }, (_, i) => Math.sin(i) + (i % 3));
    const im = new Float64Array(16);
    const orig = re.slice();
    fft.transform(re, im);
    // DC bin is the sum.
    expect(re[0]).toBeCloseTo(
      orig.reduce((a, b) => a + b, 0),
      9,
    );
    fft.transform(re, im, true);
    for (let i = 0; i < 16; i++) expect(re[i]).toBeCloseTo(orig[i]!, 9);
    expect(() => new FFT(12)).toThrow();
  });
});

describe('EchoCanceller', () => {
  it('removes the interviewer from the microphone while the candidate is quiet', () => {
    const far = speechLike(6, 1);
    const echo = convolve(far, echoPath(40, 0.4));
    const aec = new EchoCanceller();
    const out = run(aec, far, echo, 2);
    // After 3 s of learning, the echo is mostly gone (the output lags ~70 ms).
    const from = 3 * RATE;
    const to = Math.round(5.5 * RATE);
    const reduction = db(power(echo, from, to), power(out, from + 1100, to + 1100));
    expect(reduction).toBeGreaterThan(15);
    const s = aec.stats;
    expect(s.linearErleDb!).toBeGreaterThan(10);
    expect(s.erleDb!).toBeGreaterThan(18);
    expect(s.delayMs).toBeGreaterThanOrEqual(30);
    expect(s.delayMs).toBeLessThanOrEqual(50);
  });

  it('passes the candidate through unchanged when the interviewer is quiet', () => {
    const near = speechLike(4, 2);
    const aec = new EchoCanceller();
    const out = run(aec, new Float64Array(near.length), near);
    const from = RATE;
    const to = 3 * RATE;
    const { lag, c } = bestLag(out, near, from, to);
    expect(c).toBeGreaterThan(0.99);
    expect(Math.abs(db(power(out, from, to), power(near, from - lag, to - lag)))).toBeLessThan(0.5);
  });

  it('keeps the candidate when both talk, and keeps working afterwards', () => {
    const far = speechLike(10, 3);
    const nearOnly = speechLike(10, 4, 0.2);
    const near = new Float64Array(far.length);
    // The candidate talks from 4 s to 6 s, over the interviewer.
    near.set(nearOnly.subarray(4 * RATE, 6 * RATE), 4 * RATE);
    const echo = convolve(far, echoPath(60, 0.3));
    const mic = echo.map((v, i) => v + near[i]!);
    const aec = new EchoCanceller();
    const out = run(aec, far, mic, 1);
    // During double talk the candidate's voice comes through clearer than in
    // the raw microphone, and at about its own level.
    const raw = correlation(mic, near, 4.2 * RATE, 5.8 * RATE, 0);
    const { c, lag } = bestLag(out, near, 4.2 * RATE, 5.8 * RATE);
    expect(c).toBeGreaterThan(Math.min(0.97, raw + 0.05));
    const kept = db(
      power(out, 4.2 * RATE, 5.8 * RATE),
      power(near, 4.2 * RATE - lag, 5.8 * RATE - lag),
    );
    expect(Math.abs(kept)).toBeLessThan(3);
    // Afterwards the echo is still cancelled (the filter didn't fall apart).
    const after = db(power(echo, 7.5 * RATE, 9.5 * RATE), power(out, 7.6 * RATE, 9.6 * RATE));
    expect(after).toBeGreaterThan(15);
    expect(aec.stats.resets).toBe(0);
    expect(aec.stats.doubleTalkBlocks).toBeGreaterThan(50);
    process.stdout.write(
      `double talk: raw ${raw.toFixed(2)} → ${c.toFixed(2)}, level ${kept.toFixed(1)} dB\n`,
    );
  });

  it('handles a microphone that leads the reference', () => {
    // The capture timing puts the echo 30 ms *before* the reference.
    const far = speechLike(6, 5);
    const lead = Math.round(0.03 * RATE);
    const echo = convolve(far, echoPath(0, 0.4)).map((_, i, a) => a[i + lead] ?? 0);
    const aec = new EchoCanceller();
    const out = run(aec, far, echo);
    const reduction = db(power(echo, 3 * RATE, 5.5 * RATE), power(out, 3.1 * RATE, 5.6 * RATE));
    expect(reduction).toBeGreaterThan(15);
    expect(aec.stats.delayMs).toBeLessThan(0);
  });

  it('never holds the microphone back when the reference stops', () => {
    const near = speechLike(2, 6);
    const aec = new EchoCanceller();
    let frames = 0;
    for (let f = 0; f < near.length / FRAME; f++)
      frames += aec.process(toPcm(near, f * FRAME)).length;
    // Everything but the startup delay comes out.
    expect(frames).toBeGreaterThan(near.length / FRAME - 15);
  });
});
