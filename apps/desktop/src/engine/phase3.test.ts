import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav, tone } from '@aic/core';
import type { EngineEvents, LiveSuggestion, LiveTranscriptUpdate } from '@aic/ipc';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { exportTranscript, formatClock } from './sessions';

const KEY = 'AIza-unit-test-key-000000000wxyz';
const dirs: string[] = [];
const stops: (() => unknown)[] = [];

/** Silence and tone bursts ("speech") at 16 kHz, as a WAV file. */
function speechWav(dir: string, name: string, pattern: [silenceMs: number, speechMs: number][]) {
  const parts: Int16Array[] = [];
  for (const [silence, speech] of pattern) {
    parts.push(new Int16Array(16 * silence), tone(speech, 300, -20));
  }
  parts.push(new Int16Array(16 * 2000));
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const file = join(dir, name);
  writeFileSync(file, encodeWav(all));
  return file;
}

async function setup(replay: { interviewer: string | null; candidate: string | null } | null) {
  const dir = mkdtempSync(join(tmpdir(), 'aic-p3-'));
  dirs.push(dir);
  const events: { event: keyof EngineEvents; data: unknown }[] = [];
  const engine = createEngine({
    emit: (event, data) => events.push({ event, data }),
    exit: () => undefined,
    logToConsole: false,
    today: () => '2026-11-04',
  });
  const h = engine.handlers;
  const init = {
    dbPath: join(dir, 'app.db'),
    dbKeyHex: randomBytes(32).toString('hex'),
    backupDir: join(dir, 'bk'),
    logDir: join(dir, 'logs'),
    appVersion: 'test',
    fakeProvider: true,
    nativeAudioPath: null,
    audioReplay: replay,
  };
  await h.init(init);
  stops.push(() => h.shutdown());
  await h['apiKey.activate']({ provider: 'gemini', key: KEY, verification: null, models: null });
  const of = <K extends keyof EngineEvents>(event: K) =>
    events.filter((e) => e.event === event).map((e) => e.data as EngineEvents[K]);
  return { h, dir, init, of, engine };
}

/** Handlers may throw synchronously; the RPC layer turns that into a rejection. */
const call = async <T>(fn: () => T | Promise<T>): Promise<T> => fn();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | false, timeoutMs = 8000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}

afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('live interview (recorded audio, fake transcription)', () => {
  it('transcribes both channels, suggests a prepared answer, and saves the session', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aic-wav-'));
    dirs.push(tmp);
    const interviewer = speechWav(tmp, 'interviewer.wav', [
      [300, 1400],
      [900, 1600],
    ]);
    const candidate = speechWav(tmp, 'candidate.wav', [[2000, 600]]);
    const { h, of } = await setup({ interviewer, candidate });

    // A profile with an approved answer to "tell me about yourself".
    const profile = await h['profiles.import']({
      jobId: 'job-p3-profile-1',
      fileName: 'jordan.pdf',
      data: new Uint8Array(
        readFileSync(
          join(__dirname, '../../../../packages/core/fixtures/resume-jordan-rivera.pdf'),
        ),
      ),
      profileId: null,
    });
    await h['answers.add']({
      profileId: profile.id,
      fields: {
        question: 'Tell me about yourself.',
        variants: ['Can you tell me a little bit about yourself?'],
        category: 'intro',
        answer: "I'm a platform engineer.",
        status: 'approved',
      },
    });

    const started = await h['live.start']({
      mode: 'interview',
      title: 'Acme round 1',
      profileId: profile.id,
      knowledgeBaseId: null,
      transcribe: true,
    });
    expect(started).toMatchObject({ mode: 'interview', status: 'live', backend: 'replay' });
    await expect(
      call(() =>
        h['live.start']({
          mode: 'test',
          title: '',
          profileId: null,
          knowledgeBaseId: null,
          transcribe: false,
        }),
      ),
    ).rejects.toThrow(/in progress/);

    // Both interviewer lines become final segments.
    const finals = () =>
      of('live.transcript').filter((u: LiveTranscriptUpdate) => u.kind === 'final');
    await until(() => finals().filter((u) => u.segment.channel === 'interviewer').length >= 2);
    await until(() => finals().some((u) => u.segment.channel === 'candidate'));
    const interims = of('live.transcript').filter((u) => u.kind === 'interim');
    expect(interims.length).toBeGreaterThan(3);
    // Interim text grows word by word.
    expect(interims[0]!.segment.text.split(' ').length).toBeLessThanOrEqual(2);

    const suggestion = await until(() =>
      of('live.suggestion').find((s): s is LiveSuggestion => s !== null),
    );
    expect(suggestion.answer.question).toBe('Tell me about yourself.');

    const meters = of('live.meter');
    expect(meters.length).toBeGreaterThan(10);
    expect(meters.some((m) => m.levels.interviewer.speaking && m.levels.interviewer.db > -30)).toBe(
      true,
    );

    // A window opened mid-session can catch up.
    const transcript = await h['live.transcript']();
    expect(transcript?.segments.length).toBeGreaterThanOrEqual(3);

    const paused = await h['live.pause']();
    expect(paused?.status).toBe('paused');
    await h['live.resume']();
    const ended = await h['live.stop']();
    expect(ended?.status).toBe('ended');
    expect(of('live.state').at(-1)?.status).toBe('ended');

    const [summary] = await h['sessions.list']();
    expect(summary).toMatchObject({
      id: started.id,
      title: 'Acme round 1',
      status: 'ended',
      profileName: 'Jordan Rivera',
    });
    expect(summary!.durationMs).toBeGreaterThan(3000);
    const detail = await h['sessions.get']({ id: started.id });
    const texts = detail.segments.map((s) => `${s.channel}: ${s.text}`);
    expect(texts).toEqual(
      expect.arrayContaining([
        "interviewer: Hi, thanks for joining us today. How's your day going so far?",
        'interviewer: To get started, can you tell me a little bit about yourself?',
        "candidate: Thanks for having me. It's going well.",
      ]),
    );
    // Segments are in time order.
    const starts = detail.segments.map((s) => s.startMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(detail.audio.backend).toBe('replay');
    expect(detail.stats?.audioSeconds.interviewer).toBeGreaterThan(2);

    const md = await h['sessions.export']({ id: started.id, format: 'markdown' });
    expect(md.fileName).toMatch(/^acme-round-1-\d{4}-\d{2}-\d{2}\.md$/);
    expect(md.text).toContain('# Acme round 1');
    expect(md.text).toContain('**Interviewer** (00:00): Hi, thanks');

    const renamed = await h['sessions.rename']({ id: started.id, title: 'Acme, round 1' });
    expect(renamed.title).toBe('Acme, round 1');
    await h['sessions.delete']({ id: started.id });
    expect(await h['sessions.list']()).toEqual([]);
  }, 20_000);

  it('runs an audio test without a key or transcription and saves nothing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aic-wav-'));
    dirs.push(tmp);
    const { h, of } = await setup({
      interviewer: speechWav(tmp, 'i.wav', [[100, 800]]),
      candidate: null,
    });
    await h['apiKey.clear']({ provider: 'gemini' });
    const state = await h['live.start']({
      mode: 'test',
      title: '',
      profileId: null,
      knowledgeBaseId: null,
      transcribe: false,
    });
    expect(state).toMatchObject({ mode: 'test', transcribing: false, title: 'Audio test' });
    await until(() => of('live.meter').some((m) => m.levels.interviewer.db > -30));
    const diagnostics = await h['live.diagnostics']();
    expect(diagnostics).toContain('Capture: replay');
    expect(diagnostics).toContain('"mode": "test"');
    await h['live.stop']();
    expect(await h['sessions.list']()).toEqual([]);
  });

  it('needs an API key to transcribe', async () => {
    const { h } = await setup({ interviewer: null, candidate: null });
    await h['apiKey.clear']({ provider: 'gemini' });
    await expect(
      call(() =>
        h['live.start']({
          mode: 'interview',
          title: '',
          profileId: null,
          knowledgeBaseId: null,
          transcribe: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'no_api_key' });
  });

  it('ends a running interview cleanly when the engine shuts down', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aic-wav-'));
    dirs.push(tmp);
    const first = await setup({
      interviewer: speechWav(tmp, 'i.wav', [[100, 800]]),
      candidate: null,
    });
    const started = await first.h['live.start']({
      mode: 'interview',
      title: '',
      profileId: null,
      knowledgeBaseId: null,
      transcribe: true,
    });
    expect(started.title).toBe('Interview');
    stops.pop();
    await first.h.shutdown();

    const engine = createEngine({
      emit: () => undefined,
      exit: () => undefined,
      logToConsole: false,
    });
    await engine.handlers.init(first.init);
    stops.push(() => engine.handlers.shutdown());
    const [session] = await engine.handlers['sessions.list']();
    expect(session).toMatchObject({ id: started.id, status: 'ended' });
  });
});

describe('sessions helpers', () => {
  it('formats clocks and exports plain text', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65_400)).toBe('01:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    const out = exportTranscript(
      {
        id: 's',
        title: 'Hello / World',
        status: 'ended',
        profileName: null,
        knowledgeBaseName: null,
        startedAt: Date.UTC(2026, 10, 4, 12),
        endedAt: null,
        durationMs: 61_000,
        segmentCount: 2,
        audio: { backend: 'native', interviewer: null, candidate: null },
        stats: null,
        segments: [
          { id: 'a', channel: 'interviewer', text: 'Why us?', startMs: 1000, endMs: 2000 },
          { id: 'b', channel: 'candidate', text: 'Because.', startMs: 3000, endMs: 3500 },
        ],
      },
      'text',
    );
    expect(out.fileName).toMatch(/^hello-world-2026-11-0\d\.txt$/);
    expect(out.text).toContain('[00:01] Interviewer: Why us?\n[00:03] You: Because.');
  });
});
