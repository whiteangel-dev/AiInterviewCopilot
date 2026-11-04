import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveTranscriptUpdate, SessionDetail } from '@aic/ipc';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { exportTranscript, formatClock } from './sessions';
import { call, cleanup, dirs, setup, speechWav, stops, until } from './test-helpers';

afterEach(cleanup);

describe('live interview (recorded audio, fake transcription)', () => {
  it('transcribes both channels, answers from the answer bank, and saves the session', async () => {
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

    // The approved answer is shown as it is, without asking the model.
    const fromBank = await until(() => of('live.answer').find((a) => a.source === 'bank'));
    expect(fromBank).toMatchObject({
      runId: started.id,
      text: "I'm a platform engineer.",
      status: 'done',
      heard: 'To get started, can you tell me a little bit about yourself?',
    });

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

    const md = await h['sessions.export']({
      id: started.id,
      format: 'markdown',
      includeAnswers: false,
    });
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
  const session: SessionDetail = {
    id: 's',
    title: 'Hello / World',
    status: 'ended',
    profileName: null,
    knowledgeBaseName: null,
    startedAt: Date.UTC(2026, 10, 4, 12),
    endedAt: null,
    durationMs: 61_000,
    segmentCount: 2,
    answerCount: 1,
    audio: { backend: 'native', interviewer: null, candidate: null },
    stats: null,
    segments: [
      { id: 'a', channel: 'interviewer', text: 'Why us?', startMs: 1000, endMs: 2000 },
      { id: 'b', channel: 'candidate', text: 'Because.', startMs: 3000, endMs: 3500 },
    ],
    answers: [
      {
        id: 'x',
        questionId: 'q',
        question: 'Why us?',
        heard: 'Why us?',
        type: 'motivation',
        source: 'bank',
        trigger: 'analyzer',
        length: 'standard',
        model: null,
        text: "I like what you're building.\n- Point one",
        status: 'done',
        latencyMs: 900,
        askedAtMs: 2000,
        createdAt: 0,
      },
    ],
  };

  it('formats clocks and exports plain text', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65_400)).toBe('01:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    const out = exportTranscript(session, 'text');
    expect(out.fileName).toMatch(/^hello-world-2026-11-0\d\.txt$/);
    expect(out.text).toContain('[00:01] Interviewer: Why us?\n[00:03] You: Because.');
    expect(out.text).not.toContain('Suggested answer');
  });

  it('can include the answers shown, between each question and the reply', () => {
    const md = exportTranscript(session, 'markdown', true);
    expect(md.text).toContain(
      "**Interviewer** (00:01): Why us?\n\n> **Suggested answer (answer bank)**\n> I like what you're building.\n> - Point one\n\n**You** (00:03): Because.",
    );
    const text = exportTranscript(session, 'text', true);
    expect(text.text).toContain(
      "[00:01] Interviewer: Why us?\n    Suggested answer (answer bank):\n    I like what you're building.\n    - Point one\n[00:03] You: Because.",
    );
  });
});
