import { randomUUID } from 'node:crypto';
import {
  ECHO_TICKS_PER_SECOND,
  EchoDetector,
  SILENCE_DB,
  VoiceActivityDetector,
  levelDb,
  transcriptSimilarity,
  type Logger,
  type SttProvider,
  type SttStream,
  type SttStreamOptions,
} from '@aic/core';
import {
  AUDIO_CHANNELS,
  AppError,
  type AudioChannel,
  type ChannelStatus,
  type LiveMeter,
  type LiveMode,
  type LiveState,
  type LiveTranscript,
  type LiveTranscriptUpdate,
  type SessionStats,
  type TranscriptSegment,
} from '@aic/ipc';
import type { AudioSources, RunningSource, SourceStatus } from './audio-sources';
import type { CopilotHooks } from './copilot';

/** Meter and health checks run at this interval. */
const TICK_MS = 1000 / ECHO_TICKS_PER_SECOND;
/** An interim transcript with no update for this long is kept as final. */
const STALE_INTERIM_MS = 6_000;
/** No frames for this long means the source has stalled. */
const STALL_MS = 2_500;
/** A microphone line this similar to a recent interviewer line is echo. */
const ECHO_SIMILARITY = 0.75;
const ECHO_WINDOW_MS = 8_000;
/** How long after speech starts the first interim text usually arrives. */
const INTERIM_LAG_MS = 500;
/** Save the listening time this often, so a crash loses little. */
const CHECKPOINT_MS = 10_000;

export interface LiveRunEvents {
  state(state: LiveState): void;
  meter(meter: LiveMeter): void;
  transcript(update: LiveTranscriptUpdate): void;
}

export interface LiveRunOptions {
  id: string;
  mode: LiveMode;
  title: string;
  sources: AudioSources;
  /** null: capture only (audio test without transcription). */
  stt: SttProvider | null;
  sttOptions: (channel: AudioChannel) => SttStreamOptions;
  transcribeChannels: readonly AudioChannel[];
  /** Interview sessions save final segments; returns the stored segment ID. */
  saveSegment: ((segment: Omit<TranscriptSegment, 'id'>) => string) | null;
  checkpoint: ((durationMs: number, stats: SessionStats) => void) | null;
  /** Live answers (interviews): gets voice activity, transcript and ticks. */
  copilot: ((clock: { now(): number; sessionMs(): number }) => CopilotHooks) | null;
  events: LiveRunEvents;
  log: Logger;
  now?: () => number;
}

interface Channel {
  name: AudioChannel;
  vad: VoiceActivityDetector;
  source: RunningSource | null;
  stt: SttStream | null;
  status: ChannelStatus;
  /** Linear energy sum and frame count since the last meter tick. */
  energy: number;
  frames: number;
  totalFrames: number;
  filledFrames: number;
  lastFrameAt: number;
  speechStartMs: number | null;
  speechEndMs: number | null;
  /** Last time this channel was clearly not silent (for "is your mic muted?"). */
  lastSoundAt: number;
  interim: TranscriptSegment | null;
  interimAt: number;
  sourceProblem: string | null;
  sttProblem: string | null;
}

const OFF: ChannelStatus = { capture: 'off', stt: 'off', source: null, error: null };

/**
 * One live run: capture → level meter and voice detection → live transcription
 * → transcript (saved for interviews) and live answers (the copilot). Also an
 * audio test, which saves nothing.
 */
export class LiveRun {
  readonly id: string;
  readonly mode: LiveMode;
  #state: LiveState;
  readonly #channels: Record<AudioChannel, Channel>;
  readonly #segments: TranscriptSegment[] = [];
  readonly #echo = new EchoDetector();
  readonly #now: () => number;
  #tick: ReturnType<typeof setInterval> | undefined;
  #activeBefore = 0;
  #resumedAt: number | null = null;
  #startedAtMono = 0;
  #lastCheckpoint = 0;
  #echoDropped = 0;
  #interimCount = 0;
  readonly copilot: CopilotHooks | null;
  #sttStats = { audioSeconds: { interviewer: 0, candidate: 0 }, reconnects: 0 };

  constructor(private readonly options: LiveRunOptions) {
    this.id = options.id;
    this.mode = options.mode;
    this.#now = options.now ?? (() => performance.now());
    const transcribing = options.stt !== null && options.transcribeChannels.length > 0;
    this.#channels = Object.fromEntries(
      AUDIO_CHANNELS.map((name) => [name, this.#newChannel(name)]),
    ) as Record<AudioChannel, Channel>;
    this.#state = {
      id: options.id,
      mode: options.mode,
      title: options.title,
      status: 'starting',
      startedAt: Date.now(),
      elapsedMs: 0,
      updatedAt: Date.now(),
      backend: options.sources.backend,
      transcribing,
      channels: { interviewer: { ...OFF }, candidate: { ...OFF } },
      echoSuspected: false,
      warnings: [...options.sources.warnings],
      error: null,
    };
    this.copilot =
      options.copilot?.({ now: () => this.#now(), sessionMs: () => this.activeMs() }) ?? null;
  }

  #newChannel(name: AudioChannel): Channel {
    return {
      name,
      vad: new VoiceActivityDetector(),
      source: null,
      stt: null,
      status: { ...OFF },
      energy: 0,
      frames: 0,
      totalFrames: 0,
      filledFrames: 0,
      lastFrameAt: 0,
      speechStartMs: null,
      speechEndMs: null,
      lastSoundAt: 0,
      interim: null,
      interimAt: 0,
      sourceProblem: null,
      sttProblem: null,
    };
  }

  get state(): LiveState {
    return structuredClone({
      ...this.#state,
      elapsedMs: this.activeMs(),
      updatedAt: Date.now(),
      channels: {
        interviewer: { ...this.#channels.interviewer.status },
        candidate: { ...this.#channels.candidate.status },
      },
    });
  }

  get finished(): boolean {
    return this.#state.status === 'ended' || this.#state.status === 'failed';
  }

  /** Listening time so far, pauses excluded. */
  activeMs(): number {
    return Math.round(
      this.#activeBefore + (this.#resumedAt === null ? 0 : this.#now() - this.#resumedAt),
    );
  }

  start(): void {
    this.#startedAtMono = this.#now();
    this.#lastCheckpoint = this.#startedAtMono;
    this.#resume();
    this.#tick = setInterval(() => this.#onTick(), TICK_MS);
    this.#state.status = 'live';
    this.#emitState();
  }

  pause(): void {
    if (this.#state.status !== 'live') return;
    this.copilot?.pause();
    this.#halt();
    this.#state.status = 'paused';
    this.#emitState();
  }

  resume(): void {
    if (this.#state.status !== 'paused') return;
    this.copilot?.resume();
    this.#resume();
    this.#state.status = 'live';
    this.#emitState();
  }

  stop(): void {
    if (this.finished) return;
    this.#state.status = 'stopping';
    this.copilot?.stop();
    this.#halt();
    clearInterval(this.#tick);
    this.#state.status = 'ended';
    this.#checkpoint(true);
    this.options.log.info('live run ended', {
      mode: this.mode,
      ms: this.activeMs(),
      segments: this.#segments.length,
      ...this.stats(),
    });
    this.#emitState();
  }

  transcript(): LiveTranscript {
    const interim: LiveTranscript['interim'] = {};
    for (const c of Object.values(this.#channels))
      if (c.interim) interim[c.name] = { ...c.interim };
    return { id: this.id, segments: this.#segments.map((s) => ({ ...s })), interim };
  }

  stats(): SessionStats {
    return {
      audioSeconds: {
        interviewer: Math.round(this.#sttStats.audioSeconds.interviewer),
        candidate: Math.round(this.#sttStats.audioSeconds.candidate),
      },
      reconnects: this.#sttStats.reconnects,
      echoDropped: this.#echoDropped,
      ...(this.copilot ? { turns: { ...this.copilot.stats } } : {}),
    };
  }

  /** Counters for the troubleshooting report (no audio, no transcript text). */
  diagnostics(): Record<string, unknown> {
    const now = this.#now();
    const channels = Object.fromEntries(
      Object.values(this.#channels).map((c) => [
        c.name,
        {
          status: c.status,
          frames: c.totalFrames,
          filledFrames: c.filledFrames,
          msSinceLastFrame: c.lastFrameAt ? Math.round(now - c.lastFrameAt) : null,
          noiseFloorDb: Math.round(c.vad.noiseFloorDb),
          speaking: c.vad.speaking,
        },
      ]),
    );
    return {
      mode: this.mode,
      status: this.#state.status,
      backend: this.options.sources.backend,
      activeMs: this.activeMs(),
      segments: this.#segments.length,
      echoSuspected: this.#echo.suspected,
      echoCorrelation: Math.round(this.#echo.correlation * 100) / 100,
      stats: this.stats(),
      channels,
      sources: this.options.sources.details(),
      warnings: this.#state.warnings,
    };
  }

  // ── Running ───────────────────────────────────────────────────────────────

  #resume() {
    this.#resumedAt = this.#now();
    for (const c of Object.values(this.#channels)) {
      c.lastFrameAt = this.#now();
      c.lastSoundAt = this.#now();
      c.status.capture = 'starting';
      c.source = this.options.sources.start(c.name, {
        frame: (pcm, filled) => this.#onFrame(c, pcm, filled),
        status: (s) => this.#onSourceStatus(c, s),
      });
      if (this.options.stt && this.options.transcribeChannels.includes(c.name)) {
        c.status.stt = 'connecting';
        c.stt = this.options.stt.open(this.options.sttOptions(c.name), {
          onInterim: (text) => this.#onInterim(c, text),
          onFinal: (text) => this.#onFinal(c, text),
          onState: (state, detail) => {
            c.status.stt = state;
            c.sttProblem = state === 'error' || state === 'reconnecting' ? detail : null;
            this.#refreshErrors();
            this.#emitState();
          },
          onLog: (message, data) => this.options.log.info(`stt: ${message}`, data),
        });
      }
    }
  }

  /** Stops capture and transcription (pause or stop), keeping unfinished words. */
  #halt() {
    if (this.#resumedAt !== null) {
      this.#activeBefore += this.#now() - this.#resumedAt;
      this.#resumedAt = null;
    }
    for (const c of Object.values(this.#channels)) {
      c.source?.stop();
      c.source = null;
      if (c.stt) {
        this.#sttStats.audioSeconds[c.name] += c.stt.stats.audioSeconds;
        this.#sttStats.reconnects += c.stt.stats.reconnects;
        c.stt.close();
        c.stt = null;
      }
      if (c.interim?.text) this.#onFinal(c, c.interim.text);
      c.interim = null;
      c.status = { ...c.status, capture: 'off', stt: 'off' };
      c.vad = new VoiceActivityDetector();
      c.speechStartMs = null;
    }
  }

  #onFrame(c: Channel, pcm: Int16Array, filled: boolean) {
    if (this.#state.status !== 'live') return;
    const now = this.#now();
    c.lastFrameAt = now;
    c.totalFrames++;
    if (filled) c.filledFrames++;
    if (
      c.status.capture !== 'ok' &&
      c.status.capture !== 'recovering' &&
      c.status.capture !== 'error'
    ) {
      c.status.capture = 'ok';
      this.#emitState();
    }
    const db = levelDb(pcm);
    c.energy += 10 ** (db / 10);
    c.frames++;
    if (db > -60) c.lastSoundAt = now;
    if (c.vad.push(db)) {
      const t = this.activeMs();
      if (c.vad.speaking) c.speechStartMs = Math.max(0, t - 60);
      else c.speechEndMs = Math.max(0, t - 300);
      this.copilot?.speech(c.name, c.vad.speaking);
    }
    c.stt?.write(pcm, c.vad.speaking);
  }

  #onSourceStatus(c: Channel, s: SourceStatus) {
    c.status.capture = s.state;
    if (s.source) c.status.source = s.source;
    c.sourceProblem = s.message;
    this.#refreshErrors();
    this.#emitState();
  }

  #refreshErrors() {
    for (const c of Object.values(this.#channels)) {
      c.status.error = c.sourceProblem ?? c.sttProblem ?? null;
    }
    this.#refreshWarnings();
  }

  // ── Transcript ────────────────────────────────────────────────────────────

  #onInterim(c: Channel, text: string) {
    if (this.finished) return;
    const now = this.activeMs();
    if (!c.interim) {
      const start =
        c.speechStartMs !== null && now - c.speechStartMs < 15_000
          ? c.speechStartMs
          : Math.max(0, now - INTERIM_LAG_MS);
      c.interim = {
        id: `interim-${++this.#interimCount}`,
        channel: c.name,
        text,
        startMs: start,
        endMs: now,
      };
    }
    c.interim.text = text;
    c.interim.endMs = now;
    c.interimAt = this.#now();
    this.options.events.transcript({ id: this.id, kind: 'interim', segment: { ...c.interim } });
    this.copilot?.interim(c.name, c.interim);
  }

  #onFinal(c: Channel, raw: string) {
    const text = raw.trim();
    const now = this.activeMs();
    const startMs = c.interim?.startMs ?? c.speechStartMs ?? Math.max(0, now - 1000);
    const endMs =
      c.speechEndMs !== null && c.speechEndMs >= startMs && now - c.speechEndMs < 5_000
        ? c.speechEndMs
        : now;
    c.interim = null;
    c.speechStartMs = null;
    if (!text) return;

    if (c.name === 'candidate' && this.#isEcho(text, startMs)) {
      this.#echoDropped++;
      // Clear the interim line in the UI.
      this.options.events.transcript({
        id: this.id,
        kind: 'interim',
        segment: { id: 'echo', channel: c.name, text: '', startMs, endMs },
      });
      return;
    }

    const segment: TranscriptSegment = { id: randomUUID(), channel: c.name, text, startMs, endMs };
    if (this.options.saveSegment) {
      try {
        segment.id = this.options.saveSegment({ channel: c.name, text, startMs, endMs });
      } catch (err) {
        this.options.log.error('saving a transcript segment failed', { err });
      }
    }
    this.#segments.push(segment);
    this.options.events.transcript({ id: this.id, kind: 'final', segment });
    this.copilot?.final(c.name, segment);
  }

  #isEcho(text: string, startMs: number): boolean {
    for (let i = this.#segments.length - 1; i >= 0; i--) {
      const s = this.#segments[i]!;
      if (startMs - s.endMs > ECHO_WINDOW_MS) break;
      if (s.channel === 'interviewer' && transcriptSimilarity(text, s.text) >= ECHO_SIMILARITY) {
        return true;
      }
    }
    return false;
  }

  // ── Ticks: meter, echo, health ────────────────────────────────────────────

  #onTick() {
    if (this.#state.status !== 'live') return;
    const now = this.#now();
    const levels = {} as LiveMeter['levels'];
    const avg: Record<AudioChannel, number> = { interviewer: SILENCE_DB, candidate: SILENCE_DB };
    let changed = false;
    for (const c of Object.values(this.#channels)) {
      const db =
        c.frames > 0 && c.energy > 0
          ? Math.max(SILENCE_DB, 10 * Math.log10(c.energy / c.frames))
          : SILENCE_DB;
      avg[c.name] = db;
      levels[c.name] = { db: Math.round(db), speaking: c.vad.speaking };
      c.energy = 0;
      c.frames = 0;

      // A source that stops delivering frames (driver hiccup, closed window).
      const stalled = now - c.lastFrameAt > STALL_MS;
      if (stalled && c.status.capture === 'ok') {
        c.status.capture = 'recovering';
        c.sourceProblem = `No ${c.name === 'candidate' ? 'microphone' : 'interviewer'} audio is arriving.`;
        changed = true;
      } else if (
        !stalled &&
        c.status.capture === 'recovering' &&
        c.sourceProblem?.startsWith('No ')
      ) {
        c.status.capture = 'ok';
        c.sourceProblem = null;
        changed = true;
      }

      // Keep words that never got a final transcript.
      if (c.interim && now - c.interimAt > STALE_INTERIM_MS) this.#onFinal(c, c.interim.text);
    }
    this.options.events.meter({ id: this.id, levels });
    this.copilot?.tick();

    if (this.#echo.push(avg.interviewer, avg.candidate, this.#channels.interviewer.vad.speaking)) {
      this.#state.echoSuspected = this.#echo.suspected;
      changed = true;
    }
    const before = this.#state.warnings.join('\n');
    this.#refreshErrors();
    if (changed || before !== this.#state.warnings.join('\n')) this.#emitState();

    if (now - this.#lastCheckpoint >= CHECKPOINT_MS) {
      this.#lastCheckpoint = now;
      this.#checkpoint(false);
    }
  }

  #refreshWarnings() {
    const warnings = [...this.options.sources.warnings];
    const now = this.#now();
    const live = this.#state.status === 'live';
    const elapsed = now - this.#startedAtMono;
    if (this.#state.echoSuspected) {
      warnings.push(
        'Your microphone is picking up the interviewer. Use headphones so the copilot can tell you apart.',
      );
    }
    const mic = this.#channels.candidate;
    if (live && elapsed > 20_000 && mic.status.capture === 'ok' && now - mic.lastSoundAt > 30_000) {
      warnings.push("Your microphone has been silent for a while. Check that it isn't muted.");
    }
    this.#state.warnings = warnings;
  }

  #checkpoint(final: boolean) {
    if (!this.options.checkpoint) return;
    const stats = this.stats();
    for (const c of Object.values(this.#channels)) {
      if (c.stt) {
        stats.audioSeconds[c.name] += Math.round(c.stt.stats.audioSeconds);
        stats.reconnects += c.stt.stats.reconnects;
      }
    }
    try {
      this.options.checkpoint(this.activeMs(), stats);
    } catch (err) {
      this.options.log.error('saving session progress failed', { err, final });
    }
  }

  #emitState() {
    this.options.events.state(this.state);
  }
}

export function assertNotRunning(run: LiveRun | null): void {
  if (run && !run.finished) {
    throw new AppError(
      'invalid_input',
      run.mode === 'test'
        ? 'An audio test is running. Stop it first.'
        : 'An interview is in progress. End it first.',
    );
  }
}
