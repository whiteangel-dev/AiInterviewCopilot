import { randomUUID } from 'node:crypto';
import { release } from 'node:os';
import { FakeSttProvider, GeminiLiveStt, matchHeard, type SttProvider } from '@aic/core';
import type { SessionAnswerWithQuestion, SessionListRow, SessionRow } from '@aic/db';
import {
  AUDIO_CHANNELS,
  AppError,
  type AudioChannel,
  type AudioEnvironment,
  type CaptureBackend,
  type EngineMethods,
  type EnginePortMessage,
  type LiveStartParams,
  type PreparedAnswer,
  type RpcHandlers,
  type SessionAnswer,
  type SessionDetail,
  type SessionSummary,
  type TranscriptFormat,
  type TranscriptSegment,
} from '@aic/ipc';
import { buildSessionContext, buildVocabulary, compileKnowledge } from '@aic/prompts';
import { toAnswer } from './answers';
import {
  BrowserCapture,
  nativeSources,
  replaySources,
  type AudioSources,
  type PortLike,
} from './audio-sources';
import type { EngineContext } from './context';
import { LiveCopilot } from './copilot';
import { LiveRun, assertNotRunning } from './live';
import { loadNativeAudio } from './native-audio';

type SessionMethods = Pick<
  RpcHandlers<EngineMethods>,
  | 'audio.environment'
  | 'live.start'
  | 'live.pause'
  | 'live.resume'
  | 'live.stop'
  | 'live.state'
  | 'live.transcript'
  | 'live.diagnostics'
  | 'capture.failed'
  | 'live.answers'
  | 'live.answerNow'
  | 'live.regenerate'
  | 'sessions.list'
  | 'sessions.get'
  | 'sessions.rename'
  | 'sessions.delete'
  | 'sessions.export'
>;

const RETENTION_DAYS = { '7d': 7, '30d': 30, '90d': 90, '1y': 365, forever: null } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionModule {
  handlers: SessionMethods;
  /** Main connected Electron's built-in capture to the engine. */
  attachPort(message: EnginePortMessage, port: PortLike): void;
  /** After the database opens: tidy up after a crash and apply transcript retention. */
  onReady(): void;
  /** Before shutdown: end a running interview cleanly. */
  shutdown(): void;
}

const toSummary = (
  row: SessionRow & { segmentCount: number; answerCount: number },
): SessionSummary => ({
  id: row.id,
  title: row.title,
  status: row.status,
  profileName: row.profileName,
  knowledgeBaseName: row.knowledgeBaseName,
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  durationMs: row.durationMs,
  segmentCount: row.segmentCount,
  answerCount: row.answerCount,
});

const toSessionAnswer = (row: SessionAnswerWithQuestion): SessionAnswer => ({
  id: row.id,
  questionId: row.questionId,
  question: row.question.question,
  heard: row.question.heard,
  type: row.question.type,
  source: row.source,
  trigger: row.trigger,
  length: row.length,
  model: row.model,
  text: row.text,
  status: row.status,
  latencyMs: row.latencyMs,
  askedAtMs: row.question.askedAtMs,
  createdAt: row.createdAt,
});

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function exportTranscript(
  session: SessionDetail,
  format: TranscriptFormat,
  includeAnswers = false,
): { fileName: string; text: string } {
  const who = (c: AudioChannel) => (c === 'interviewer' ? 'Interviewer' : 'You');
  const date = new Date(session.startedAt);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const when = date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const meta = [
    when,
    `${formatClock(session.durationMs)} listened`,
    session.profileName ? `Profile: ${session.profileName}` : null,
    session.knowledgeBaseName ? `Knowledge: ${session.knowledgeBaseName}` : null,
  ].filter(Boolean);
  const slug =
    session.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'interview';

  // Transcript lines and (optionally) the answers shown, in time order. An
  // answer goes after the interviewer's question, before the candidate's reply.
  type Entry = { at: number; order: number; line: string };
  const entries: Entry[] = [];
  const markdown = format === 'markdown';
  session.segments.forEach((s, i) =>
    entries.push({
      at: s.startMs,
      order: i,
      line: markdown
        ? `**${who(s.channel)}** (${formatClock(s.startMs)}): ${s.text}`
        : `[${formatClock(s.startMs)}] ${who(s.channel)}: ${s.text}`,
    }),
  );
  if (includeAnswers) {
    session.answers.forEach((a, i) => {
      const body = a.text.trim() || (a.status === 'error' ? '(failed)' : '(empty)');
      const label = a.source === 'bank' ? 'Suggested answer (answer bank)' : 'Suggested answer';
      entries.push({
        at: a.askedAtMs + 1,
        order: session.segments.length + i,
        line: markdown
          ? `> **${label}**\n${body
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n')}`
          : `    ${label}:\n${body
              .split('\n')
              .map((l) => `    ${l}`)
              .join('\n')}`,
      });
    });
  }
  entries.sort((x, y) => x.at - y.at || x.order - y.order);
  const lines = entries.map((e) => e.line);
  if (markdown) {
    return {
      fileName: `${slug}-${day}.md`,
      text: `# ${session.title}\n\n${meta.join(' · ')}\n\n${lines.join('\n\n')}\n`,
    };
  }
  return {
    fileName: `${slug}-${day}.txt`,
    text: `${session.title}\n${meta.join(' | ')}\n\n${lines.join('\n')}\n`,
  };
}

export function sessionModule(ctx: EngineContext): SessionModule {
  let run: LiveRun | null = null;
  let browser: BrowserCapture | null = null;
  let purgeTimer: ReturnType<typeof setInterval> | undefined;
  const repo = () => ctx.ready().sessions;

  const native = () => loadNativeAudio(ctx.ready().init.nativeAudioPath);

  const resolveBackend = (): CaptureBackend => {
    const s = ctx.ready();
    if (s.init.audioReplay) return 'replay';
    const setting = s.settings.audio.backend;
    if (setting === 'browser') return 'browser';
    const n = native();
    const usable = n.available && n.sources.includes('microphone');
    if (setting === 'native') {
      if (!usable) {
        throw new AppError(
          'invalid_input',
          n.available
            ? "Native capture isn't supported on this system. Choose Built-in capture in Settings → Audio."
            : `${n.error} Choose Built-in capture in Settings → Audio.`,
        );
      }
      return 'native';
    }
    return usable ? 'native' : 'browser';
  };

  const createSources = (runId: string): AudioSources => {
    const s = ctx.ready();
    const backend = resolveBackend();
    if (backend === 'replay') return replaySources(s.init.audioReplay!);
    if (backend === 'native') {
      const n = native();
      if (!n.available) throw new AppError('internal', n.error);
      return nativeSources(n.module, s.settings.audio, ctx.log());
    }
    browser = new BrowserCapture(
      runId,
      {
        open: (request) => ctx.emit('capture.open', request),
        close: (id) => ctx.emit('capture.close', { runId: id }),
      },
      ctx.log(),
    );
    return browser;
  };

  const sttProvider = (): SttProvider =>
    ctx.ready().init.fakeProvider ? new FakeSttProvider() : new GeminiLiveStt();

  const detail = (id: string): SessionDetail => {
    const r = repo();
    const row = r.get(id);
    if (!row) throw new AppError('not_found', 'That session no longer exists.');
    const segments: TranscriptSegment[] = r.segments(id).map((s) => ({
      id: s.id,
      channel: s.channel,
      text: s.text,
      startMs: s.startMs,
      endMs: s.endMs,
    }));
    const answers = r.answers(id).map(toSessionAnswer);
    return {
      ...toSummary({ ...row, segmentCount: segments.length, answerCount: answers.length }),
      audio: row.audio,
      stats: row.stats,
      segments,
      answers,
    };
  };

  const environment = (): AudioEnvironment => {
    const s = ctx.ready();
    const n = native();
    let backend: CaptureBackend;
    try {
      backend = resolveBackend();
    } catch {
      backend = 'browser';
    }
    const devices = n.available ? safe(() => n.module.listDevices(), []) : [];
    const apps = n.available ? safe(() => n.module.listAudioApps?.() ?? [], []) : [];
    return {
      platform: process.platform,
      backend,
      native: n.available
        ? { available: true, error: null, sources: n.sources }
        : { available: false, error: n.error, sources: [] },
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind === 'output' ? 'output' : 'input',
        isDefault: d.isDefault,
      })),
      apps: apps
        .map((a) => ({ pid: a.pid, name: a.name, displayName: a.displayName, active: a.active }))
        .sort(
          (a, b) =>
            Number(b.active) - Number(a.active) || a.displayName.localeCompare(b.displayName),
        ),
      replay: s.init.audioReplay !== null,
    };
  };

  const purge = () => {
    const days = RETENTION_DAYS[ctx.ready().settings.privacy.transcriptRetention];
    if (days === null) return;
    const removed = repo().purgeStartedBefore(Date.now() - days * DAY_MS);
    if (removed > 0)
      ctx.log().info('old sessions removed (transcript retention)', { removed, days });
  };

  const start = (params: LiveStartParams) => {
    assertNotRunning(run);
    const s = ctx.ready();
    const settings = s.settings;
    const transcribe = params.transcribe;
    const apiKey = transcribe ? ctx.requireKey('gemini') : '';

    const version = params.profileId ? s.profiles.latestVersion(params.profileId) : undefined;
    if (params.profileId && !version)
      throw new AppError('not_found', 'That profile no longer exists.');
    const profile = params.profileId ? s.profiles.get(params.profileId) : undefined;
    const base = params.knowledgeBaseId ? s.knowledge.getBase(params.knowledgeBaseId) : undefined;
    if (params.knowledgeBaseId && !base) {
      throw new AppError('not_found', 'That knowledge base no longer exists.');
    }
    const items = base ? s.knowledge.items(base.id) : [];
    const company = params.company?.trim() ?? '';
    const role = params.role?.trim() ?? '';
    const vocabulary = buildVocabulary(version?.data ?? null, items, company ? [company] : []);
    const context = buildSessionContext({
      today: ctx.today(),
      company: company || null,
      role: role || null,
      brief: version?.brief ?? null,
      knowledge: compileKnowledge(items),
    }).text;

    // Only approved answers are shown as they are; anything else is written live.
    const approved: PreparedAnswer[] = params.profileId
      ? s.answers
          .list(params.profileId)
          .map(toAnswer)
          .filter((a) => a.status === 'approved')
      : [];

    browser = null;
    // The capture window (built-in capture) has its own ID, separate from the session's.
    const sources = createSources(randomUUID());
    const title = (
      params.title ||
      (params.mode === 'test'
        ? 'Audio test'
        : company || role
          ? [company, role].filter(Boolean).join(' · ')
          : `Interview${base ? ` · ${base.name}` : ''}`)
    ).slice(0, 120);

    let sessionId = `test-${randomUUID()}`;
    if (params.mode === 'interview') {
      sessionId = repo().create({
        title,
        profileId: profile?.id ?? null,
        profileVersionId: version?.id ?? null,
        profileName: profile?.name ?? null,
        knowledgeBaseId: base?.id ?? null,
        knowledgeBaseName: base?.name ?? null,
        context,
        vocabulary,
        audio: sources.describe(),
        startedAt: Date.now(),
      }).id;
    }
    const id = sessionId;
    const transcribeChannels: AudioChannel[] = transcribe
      ? AUDIO_CHANNELS.filter((c) => c === 'interviewer' || settings.audio.transcribeMicrophone)
      : [];
    run = new LiveRun({
      id,
      mode: params.mode,
      title,
      sources,
      stt: transcribe ? sttProvider() : null,
      sttOptions: (channel) => ({
        apiKey,
        model: settings.models.transcription,
        vocabulary,
        label: channel,
      }),
      transcribeChannels,
      saveSegment: params.mode === 'interview' ? (seg) => repo().addSegment(id, seg).id : null,
      checkpoint:
        params.mode === 'interview'
          ? (durationMs, stats) => {
              repo().update(id, {
                durationMs,
                stats,
                audio: sources.describe(),
              });
            }
          : null,
      copilot:
        params.mode === 'interview' && transcribe
          ? (clock) =>
              new LiveCopilot({
                runId: id,
                provider: ctx.ready().providers.gemini,
                apiKey,
                settings: { models: settings.models, answers: settings.answers },
                context,
                bank: (heard) => {
                  const match = matchHeard(heard, approved);
                  return match
                    ? {
                        preparedAnswerId: match.item.id,
                        question: match.item.question,
                        text: match.item.answer,
                      }
                    : null;
                },
                save: {
                  question: (row) => repo().saveQuestion(row),
                  answer: (row) => repo().saveAnswer(row),
                },
                emit: {
                  answer: (answer) => ctx.emit('live.answer', answer),
                  turn: (update) => ctx.emit('live.turn', update),
                },
                log: ctx.log().child('copilot'),
                ...clock,
              })
          : null,
      events: {
        state: (state) => ctx.emit('live.state', state),
        meter: (meter) => ctx.emit('live.meter', meter),
        transcript: (update) => ctx.emit('live.transcript', update),
      },
      log: ctx.log().child(params.mode === 'test' ? 'audio-test' : 'session'),
    });
    run.start();
    ctx.log().info('live run started', {
      mode: params.mode,
      backend: run.state.backend,
      transcribe,
      channels: transcribeChannels,
      vocabulary: vocabulary.length,
      bankAnswers: approved.length,
      autoAnswer: settings.answers.autoAnswer,
      answerMode: settings.answers.mode,
    });
    return run.state;
  };

  const activeCopilot = (): LiveCopilot => {
    if (!run || run.finished || !(run.copilot instanceof LiveCopilot)) {
      throw new AppError('invalid_input', 'Start an interview first.');
    }
    return run.copilot;
  };

  const stop = () => {
    if (!run || run.finished) return run?.state ?? null;
    const current = run;
    current.stop();
    if (current.mode === 'interview') {
      repo().update(current.id, {
        status: 'ended',
        endedAt: Date.now(),
        durationMs: current.activeMs(),
        stats: current.stats(),
      });
    }
    browser = null;
    return current.state;
  };

  const handlers: SessionMethods = {
    'audio.environment': () => environment(),
    'live.start': (params) => start(params),
    'live.pause': () => {
      run?.pause();
      return run?.state ?? null;
    },
    'live.resume': () => {
      run?.resume();
      return run?.state ?? null;
    },
    'live.stop': () => stop(),
    'live.state': () => run?.state ?? null,
    'live.transcript': () => run?.transcript() ?? null,
    'live.diagnostics': () => {
      const s = ctx.ready();
      const env = environment();
      const lines = [
        'AI Interview Copilot: audio diagnostics',
        `Generated: ${new Date().toISOString()}`,
        `App ${s.init.appVersion} · ${process.platform} ${release()} · ${process.arch}`,
        `Capture: ${env.backend} (setting: ${s.settings.audio.backend})`,
        `Native module: ${env.native.available ? `loaded (${env.native.sources.join(', ')})` : env.native.error}`,
        `Interviewer source: ${s.settings.audio.interviewerSource}${s.settings.audio.appName ? ` (${s.settings.audio.appName})` : ''}`,
        `Chosen devices: microphone ${s.settings.audio.microphoneId ? 'set' : 'default'}, output ${s.settings.audio.outputDeviceId ? 'set' : 'default'}`,
        `Transcription model: ${s.settings.models.transcription}`,
        '',
        'Devices:',
        ...(env.devices.length
          ? env.devices.map(
              (d) =>
                `  ${d.kind === 'input' ? 'mic ' : 'out '} ${d.isDefault ? '*' : ' '} ${d.name}`,
            )
          : ['  (none listed)']),
        'Apps with audio:',
        ...(env.apps.length
          ? env.apps.map((a) => `  ${a.active ? '▶' : ' '} ${a.displayName} (${a.name})`)
          : ['  (none)']),
        '',
        'Current or last run:',
        run ? JSON.stringify(run.diagnostics(), null, 2) : '  (none)',
      ];
      return lines.join('\n');
    },
    'capture.failed': ({ runId, message }) => {
      if (browser?.runId === runId) browser.fail(message);
    },
    'live.answers': () => (run?.copilot instanceof LiveCopilot ? run.copilot.answers() : []),
    'live.answerNow': () => {
      const copilot = activeCopilot();
      if (!copilot.turns.answerNow()) {
        throw new AppError(
          'invalid_input',
          "There's nothing to answer yet. The interviewer hasn't asked anything.",
        );
      }
    },
    'live.regenerate': ({ answerId, length }) => {
      if (!activeCopilot().turns.regenerate(answerId, length)) {
        throw new AppError('not_found', 'That answer is no longer available.');
      }
    },

    'sessions.list': () =>
      repo()
        .list()
        .map((r: SessionListRow) => toSummary(r)),
    'sessions.get': ({ id }) => detail(id),
    'sessions.rename': ({ id, title }) => {
      const row = repo().update(id, { title });
      if (!row) throw new AppError('not_found', 'That session no longer exists.');
      return toSummary({
        ...row,
        segmentCount: repo().segmentCount(id),
        answerCount: repo().answerCount(id),
      });
    },
    'sessions.delete': ({ id }) => {
      if (run && run.id === id && !run.finished) {
        throw new AppError('invalid_input', 'End the interview before deleting it.');
      }
      repo().delete(id);
    },
    'sessions.export': ({ id, format, includeAnswers }) =>
      exportTranscript(detail(id), format, includeAnswers),
  };

  return {
    handlers,
    attachPort(message, port) {
      if (message.purpose === 'capture' && browser && browser.runId === message.runId) {
        browser.attach(port);
      } else {
        port.close();
      }
    },
    onReady() {
      const interrupted = repo().markInterrupted();
      if (interrupted > 0) ctx.log().warn('sessions interrupted by a crash', { interrupted });
      repo().stopStreamingAnswers();
      purge();
      clearInterval(purgeTimer);
      purgeTimer = setInterval(
        () => {
          try {
            purge();
          } catch (err) {
            ctx.log().warn('transcript retention purge failed', { err });
          }
        },
        6 * 60 * 60 * 1000,
      );
      purgeTimer.unref();
    },
    shutdown() {
      clearInterval(purgeTimer);
      try {
        stop();
      } catch (err) {
        ctx.log().warn('stopping the live run at shutdown failed', { err });
      }
    },
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
