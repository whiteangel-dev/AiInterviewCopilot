import { createLogger, tone, type SttHandlers, type SttProvider } from '@aic/core';
import type { AudioChannel, LiveState, LiveTranscriptUpdate } from '@aic/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioSources, SourceHandlers } from './audio-sources';
import { LiveRun } from './live';

/** Sources the test drives frame by frame. */
function manualSources() {
  const handlers = new Map<AudioChannel, SourceHandlers>();
  const sources: AudioSources = {
    backend: 'replay',
    warnings: [],
    describe: () => ({ backend: 'replay', interviewer: null, candidate: null }),
    details: () => ({}),
    start(channel, h) {
      handlers.set(channel, h);
      h.status({ state: 'ok', message: null, source: channel });
      return { stop: () => handlers.delete(channel) };
    },
  };
  const loud = tone(20, 300, -20);
  const quiet = new Int16Array(320);
  return {
    sources,
    frame: (channel: AudioChannel, speaking: boolean) =>
      handlers.get(channel)?.frame(speaking ? loud : quiet, false),
  };
}

/** Transcription the test controls directly. */
function manualStt() {
  const streams = new Map<string, SttHandlers>();
  const provider: SttProvider = {
    open(options, handlers) {
      streams.set(options.label, handlers);
      handlers.onState('connected', null);
      return {
        write: () => undefined,
        close: () => undefined,
        stats: { audioSeconds: 0, reconnects: 0 },
      };
    },
  };
  return { provider, stt: (channel: AudioChannel) => streams.get(channel)! };
}

function setup() {
  const audio = manualSources();
  const { provider, stt } = manualStt();
  const updates: LiveTranscriptUpdate[] = [];
  const states: LiveState[] = [];
  const saved: string[] = [];
  const run = new LiveRun({
    id: 'run-1',
    mode: 'interview',
    title: 'Test',
    sources: audio.sources,
    stt: provider,
    sttOptions: (channel) => ({ apiKey: 'k', model: 'm', vocabulary: [], label: channel }),
    transcribeChannels: ['interviewer', 'candidate'],
    saveSegment: (s) => {
      saved.push(`${s.channel}: ${s.text}`);
      return `seg-${saved.length}`;
    },
    checkpoint: null,
    copilot: null,
    echoCancellation: false,
    events: {
      state: (s) => states.push(s),
      meter: () => undefined,
      transcript: (u) => updates.push(u),
    },
    log: createLogger({ console: false, scope: 'test' }),
    now: () => Date.now(),
  });
  return { run, audio, stt, updates, states, saved };
}

describe('LiveRun', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drops microphone lines that repeat the interviewer (echo)', () => {
    const { run, stt, saved, updates } = setup();
    run.start();
    stt('interviewer').onFinal('Tell me about a time you failed.');
    vi.advanceTimersByTime(1500);
    stt('candidate').onInterim('Tell me about a time');
    stt('candidate').onFinal('tell me about a time you failed');
    stt('candidate').onFinal('Sure, early in my career I shipped a bad migration.');
    expect(saved).toEqual([
      'interviewer: Tell me about a time you failed.',
      'candidate: Sure, early in my career I shipped a bad migration.',
    ]);
    // The UI is told to clear the echoed interim line.
    expect(updates.some((u) => u.kind === 'interim' && u.segment.text === '')).toBe(true);
    expect(run.stats().echoDropped).toBe(1);
    run.stop();
  });

  it('keeps words that never get a final transcript', () => {
    const { run, stt, saved } = setup();
    run.start();
    stt('interviewer').onInterim('So walk me through');
    vi.advanceTimersByTime(7000);
    expect(saved).toEqual(['interviewer: So walk me through']);
    stt('candidate').onInterim('I would start by');
    run.stop();
    expect(saved.at(-1)).toBe('candidate: I would start by');
  });

  it('reports a source that stops sending audio, and its recovery', () => {
    const { run, audio, states } = setup();
    run.start();
    audio.frame('interviewer', false);
    audio.frame('candidate', false);
    vi.advanceTimersByTime(3000);
    const stalled = states.at(-1)!;
    expect(stalled.channels.interviewer.capture).toBe('recovering');
    expect(stalled.channels.interviewer.error).toMatch(/No interviewer audio/);
    audio.frame('interviewer', false);
    audio.frame('candidate', false);
    vi.advanceTimersByTime(100);
    expect(states.at(-1)!.channels.interviewer.capture).toBe('ok');
    run.stop();
  });

  it('times segments by voice activity and excludes paused time', () => {
    const { run, audio, stt, updates } = setup();
    run.start();
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 50; i++) {
      audio.frame('interviewer', true);
      vi.advanceTimersByTime(20);
    }
    stt('interviewer').onInterim('Why');
    for (let i = 0; i < 20; i++) {
      audio.frame('interviewer', false);
      vi.advanceTimersByTime(20);
    }
    stt('interviewer').onFinal('Why this company?');
    const final = updates.find((u) => u.kind === 'final')!.segment;
    expect(final.startMs).toBeGreaterThanOrEqual(950);
    expect(final.startMs).toBeLessThanOrEqual(1100);
    expect(final.endMs).toBeGreaterThan(1900);
    expect(final.endMs).toBeLessThan(2200);

    run.pause();
    vi.advanceTimersByTime(60_000);
    run.resume();
    vi.advanceTimersByTime(1000);
    // 2.4 s before the pause + 1 s after it; the 60 s pause doesn't count.
    expect(run.activeMs()).toBe(3400);
    run.stop();
  });
});
