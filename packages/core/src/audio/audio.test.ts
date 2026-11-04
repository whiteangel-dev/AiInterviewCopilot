import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoDetector, transcriptSimilarity } from './echo';
import { FRAME_SAMPLES, SILENCE_DB, encodeWav, levelDb, readWav, tone } from './pcm';
import { startReplay } from './replay';
import { VoiceActivityDetector } from './vad';

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed = 1) {
  let s = seed;
  return () => (s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
}

describe('pcm', () => {
  it('measures levels in dBFS', () => {
    expect(levelDb(new Int16Array(320))).toBe(SILENCE_DB);
    expect(levelDb(tone(20, 1000, -20))).toBeCloseTo(-20, 0);
    expect(levelDb(tone(20, 440, -6))).toBeCloseTo(-6, 0);
  });

  it('round-trips WAV files', () => {
    const samples = tone(100, 440, -12);
    const wav = readWav(encodeWav(samples));
    expect(wav.sampleRate).toBe(16_000);
    expect(wav.channels).toBe(1);
    expect([...wav.samples]).toEqual([...samples]);
    expect(() => readWav(new Uint8Array(10))).toThrow(/WAV/);
  });
});

describe('VoiceActivityDetector', () => {
  const feed = (vad: VoiceActivityDetector, db: number, frames: number, noise = rng()) => {
    const states: boolean[] = [];
    for (let i = 0; i < frames; i++) {
      vad.push(db + (noise() - 0.5) * 2);
      states.push(vad.speaking);
    }
    return states;
  };

  it('detects speech quickly and its end after the hangover', () => {
    const vad = new VoiceActivityDetector();
    expect(feed(vad, -70, 100).some(Boolean)).toBe(false);
    const talk = feed(vad, -25, 50);
    expect(talk.indexOf(true)).toBeLessThanOrEqual(4); // ≤ 100 ms
    const after = feed(vad, -70, 50);
    const stoppedAt = after.indexOf(false);
    expect(stoppedAt).toBeGreaterThanOrEqual(13); // ~300 ms hangover
    expect(stoppedAt).toBeLessThanOrEqual(17);
  });

  it('adapts to a noisy room', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, -42, 300); // 6 s of fan noise
    expect(vad.noiseFloorDb).toBeGreaterThan(-46);
    expect(feed(vad, -42, 100).some(Boolean)).toBe(false);
    expect(feed(vad, -20, 20).some(Boolean)).toBe(true);
  });

  it('ignores very quiet sounds even in digital silence', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, -100, 100);
    expect(feed(vad, -60, 50).some(Boolean)).toBe(false);
  });
});

describe('EchoDetector', () => {
  /** Speech-like level: varies between syllables. */
  const speech = (r: () => number) => -35 + r() * 20;

  it('flags a mic that follows the interviewer (speakers, no headphones)', () => {
    const echo = new EchoDetector();
    const r = rng(7);
    let changed = false;
    for (let t = 0; t < 80; t++) {
      const i = speech(r);
      changed ||= echo.push(i, i - 18 + (r() - 0.5) * 2, true);
    }
    expect(changed).toBe(true);
    expect(echo.suspected).toBe(true);
    expect(echo.correlation).toBeGreaterThan(0.65);
  });

  it('does not flag people taking turns', () => {
    const echo = new EchoDetector();
    const r = rng(3);
    for (let round = 0; round < 4; round++) {
      for (let t = 0; t < 40; t++) echo.push(speech(r), -65 + r(), true);
      for (let t = 0; t < 40; t++) echo.push(-90, speech(r), false);
    }
    expect(echo.suspected).toBe(false);
  });

  it('does not flag a muted microphone', () => {
    const echo = new EchoDetector();
    const r = rng(5);
    for (let t = 0; t < 100; t++) echo.push(speech(r), -100, true);
    expect(echo.suspected).toBe(false);
  });

  it('compares transcript lines', () => {
    expect(transcriptSimilarity('Tell me about yourself.', 'tell me about yourself')).toBe(1);
    expect(transcriptSimilarity('Tell me about yourself', 'Sure, I build APIs')).toBe(0);
    expect(transcriptSimilarity('', 'x')).toBe(0);
  });
});

describe('startReplay', () => {
  afterEach(() => vi.useRealTimers());

  it('plays frames in real time, then silence', () => {
    vi.useFakeTimers();
    const samples = new Int16Array(FRAME_SAMPLES * 5).fill(1000);
    const frames: { level: number; filled: boolean }[] = [];
    const replay = startReplay(samples, (pcm, filled) => frames.push({ level: pcm[0]!, filled }), {
      now: () => Date.now(),
    });
    vi.advanceTimersByTime(110);
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(frames.length).toBeLessThanOrEqual(6);
    vi.advanceTimersByTime(200);
    replay.stop();
    const count = frames.length;
    expect(count).toBeGreaterThanOrEqual(14);
    expect(frames.slice(0, 5).every((f) => f.level === 1000 && !f.filled)).toBe(true);
    expect(frames.slice(5).every((f) => f.level === 0 && f.filled)).toBe(true);
    vi.advanceTimersByTime(200);
    expect(frames.length).toBe(count);
  });
});
