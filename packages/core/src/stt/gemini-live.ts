import {
  ActivityHandling,
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  VoiceActivityType,
  type LiveConnectConfig,
  type LiveServerMessage,
} from '@google/genai';
import { pcmToBase64 } from '../audio/pcm';
import { redact } from '../redact';
import type { SttHandlers, SttProvider, SttStream, SttStreamOptions } from './types';

/**
 * Live transcription with the Gemini Live API (one connection per channel).
 *
 * A Live connection lasts about 10 minutes, so the stream rolls over to a new
 * one before that (or when the server sends `goAway`): it opens the next
 * connection in the background and switches at a pause in speech, so no
 * utterance is cut in half. Transcription needs no conversation state, so a
 * fresh connection loses nothing. If a connection drops, audio is buffered
 * (up to 15 s) and sent once it reconnects.
 *
 * Only speech is sent (Phase 5): audio is billed per second sent, and an
 * interview is mostly one side listening. The gate opens on the local voice
 * detector's speech with 400 ms of audio from before it, stays open 800 ms
 * after it (the service needs 300 ms of silence to finish an utterance), then
 * ends the audio stream. A connection that gets no audio for about a minute is
 * closed by the server, so 100 ms of silence is sent every 15 s while idle.
 */

export interface LiveConnection {
  send(pcm: Int16Array): void;
  /** Tells the server no more audio is coming, so it finalizes what it heard. */
  endAudio(): void;
  close(): void;
}

export interface LiveConnectionCallbacks {
  onMessage(message: LiveServerMessage): void;
  onClose(code: number, reason: string): void;
}

/** Opens a connection and resolves once the server has accepted the setup. */
export type LiveConnector = (
  params: { apiKey: string; model: string; config: LiveConnectConfig; timeoutMs: number },
  callbacks: LiveConnectionCallbacks,
) => Promise<LiveConnection>;

export interface GeminiLiveTiming {
  /** Roll over to a new connection after this long (the server limit is ~10 min). */
  rollAfterMs: number;
  /** After the next connection is ready, wait at most this long for a pause. */
  maxHandoverWaitMs: number;
  /** Silence needed before switching connections. */
  handoverSilenceMs: number;
  /** How long an old connection may keep delivering its last transcript. */
  drainMs: number;
  retryDelaysMs: readonly number[];
  setupTimeoutMs: number;
  /** Audio kept while disconnected. */
  maxBufferMs: number;
  /** Send only speech (with padding); null sends everything. */
  gate: {
    /** Audio from before the speech started. */
    preRollMs: number;
    /** Audio after the speech ended. */
    tailMs: number;
    /** While idle, send 100 ms of silence this often so the server keeps the connection. */
    keepAliveMs: number;
  } | null;
}

export const DEFAULT_LIVE_TIMING: GeminiLiveTiming = {
  rollAfterMs: 8 * 60_000,
  maxHandoverWaitMs: 15_000,
  handoverSilenceMs: 200,
  drainMs: 4_000,
  retryDelaysMs: [250, 1_000, 2_000, 4_000, 5_000],
  setupTimeoutMs: 10_000,
  maxBufferMs: 15_000,
  gate: { preRollMs: 400, tailMs: 800, keepAliveMs: 15_000 },
};

const FRAME_MS = 20;
const SILENT_RELAY =
  'You are a silent transcription relay. Never answer or comment. If a reply is required, reply with a single period.';

/** Problems a reconnect can't fix. */
export function isFatalLiveError(reason: string): boolean {
  return /api key|api_key|permission|denied|not found|not supported|unsupported model|billing/i.test(
    reason,
  );
}

function friendlyLiveError(reason: string): string {
  if (/api key|api_key/i.test(reason)) return 'Google rejected the API key.';
  if (/not found|not supported|unsupported model/i.test(reason)) {
    return 'The transcription model is not available to this key. Pick another in Settings → Models.';
  }
  if (/quota|exhausted|rate/i.test(reason)) return 'Transcription quota or rate limit reached.';
  return reason ? `Transcription connection problem: ${redact(reason).slice(0, 200)}` : '';
}

export function liveConfig(vocabulary: readonly string[]): LiveConnectConfig {
  return {
    responseModalities: [Modality.TEXT],
    systemInstruction: SILENT_RELAY,
    inputAudioTranscription: {
      languageCodes: ['en-US'],
      ...(vocabulary.length > 0 ? { customVocabulary: [...vocabulary] } : {}),
    },
    realtimeInputConfig: {
      automaticActivityDetection: {
        silenceDurationMs: 300,
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
      },
      activityHandling: ActivityHandling.NO_INTERRUPTION,
    },
    contextWindowCompression: { slidingWindow: {} },
  };
}

/** The real connector, using @google/genai. */
export const geminiLiveConnector: LiveConnector = async (params, callbacks) => {
  const ai = new GoogleGenAI({ apiKey: params.apiKey });
  let settle: { resolve(): void; reject(err: Error): void } | null = null;
  const ready = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  const session = await ai.live.connect({
    model: params.model,
    config: params.config,
    callbacks: {
      onmessage: (message) => {
        if (message.setupComplete) settle?.resolve();
        callbacks.onMessage(message);
      },
      onerror: (event) => {
        const message = (event as { message?: unknown }).message;
        settle?.reject(new Error(typeof message === 'string' ? message : 'connection error'));
      },
      onclose: (event) => {
        settle?.reject(new Error(`closed ${event.code}: ${event.reason}`));
        callbacks.onClose(event.code, event.reason);
      },
    },
  });
  const timer = setTimeout(
    () => settle?.reject(new Error('The transcription service did not respond.')),
    params.timeoutMs,
  );
  try {
    await ready;
  } catch (err) {
    session.close();
    throw err;
  } finally {
    clearTimeout(timer);
    settle = null;
  }
  return {
    send: (pcm) =>
      session.sendRealtimeInput({
        audio: { data: pcmToBase64(pcm), mimeType: 'audio/pcm;rate=16000' },
      }),
    endAudio: () => session.sendRealtimeInput({ audioStreamEnd: true }),
    close: () => session.close(),
  };
};

interface Conn {
  n: number;
  live: LiveConnection | null;
  readyAt: number | null;
  openedAt: number;
  goAway: boolean;
  /** Final text arriving in pieces (`finished: false`). */
  pendingFinal: string;
  lastInterim: string;
  closing: boolean;
}

class GeminiLiveStream implements SttStream {
  readonly stats = { audioSeconds: 0, reconnects: 0 };
  #current: Conn | null = null;
  #next: Conn | null = null;
  readonly #draining = new Set<Conn>();
  #buffer: Int16Array[] = [];
  #closed = false;
  #failures = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #silentMs = 0;
  #count = 0;
  #gateOpen = false;
  #tailLeftMs = 0;
  #preRoll: Int16Array[] = [];
  #lastSentAt: number;
  #useVocabulary: boolean;
  #everConnected = false;
  #fatal = false;

  constructor(
    private readonly options: SttStreamOptions,
    private readonly handlers: SttHandlers,
    private readonly connector: LiveConnector,
    private readonly timing: GeminiLiveTiming,
    private readonly now: () => number,
  ) {
    this.#useVocabulary = options.vocabulary.length > 0;
    this.#lastSentAt = now();
    this.handlers.onState('connecting', null);
    this.#connect();
  }

  write(pcm: Int16Array, speaking: boolean): void {
    if (this.#closed) return;
    this.#silentMs = speaking ? 0 : this.#silentMs + FRAME_MS;
    const gate = this.timing.gate;
    if (!gate) {
      this.#send(pcm);
    } else if (speaking) {
      if (!this.#gateOpen) {
        this.#gateOpen = true;
        for (const frame of this.#preRoll) this.#send(frame);
        this.#preRoll = [];
      }
      this.#tailLeftMs = gate.tailMs;
      this.#send(pcm);
    } else if (this.#gateOpen) {
      this.#send(pcm);
      this.#tailLeftMs -= FRAME_MS;
      if (this.#tailLeftMs <= 0) {
        this.#gateOpen = false;
        this.#endAudio();
      }
    } else {
      this.#preRoll.push(pcm);
      if (this.#preRoll.length > gate.preRollMs / FRAME_MS) this.#preRoll.shift();
      if (this.now() - this.#lastSentAt >= gate.keepAliveMs) this.#keepAlive();
    }
    this.#maybeRoll();
  }

  /** Sends a frame, or keeps it while (re)connecting. Counts what is billed. */
  #send(pcm: Int16Array) {
    this.stats.audioSeconds += FRAME_MS / 1000;
    this.#lastSentAt = this.now();
    const conn = this.#current;
    if (conn?.live && conn.readyAt !== null && !conn.closing) {
      try {
        conn.live.send(pcm);
      } catch {
        this.#keep(pcm);
        this.#lost(conn, 'send failed');
      }
    } else if (!this.#fatal) {
      this.#keep(pcm);
    }
  }

  /** The speech ended: the service finishes the utterance now. */
  #endAudio() {
    const conn = this.#current;
    if (!conn?.live || conn.readyAt === null || conn.closing) return;
    try {
      conn.live.endAudio();
    } catch {
      // the connection is going away; reconnect handles it
    }
  }

  /** 100 ms of silence, only to a connected stream (never buffered). */
  #keepAlive() {
    const conn = this.#current;
    this.#lastSentAt = this.now();
    if (!conn?.live || conn.readyAt === null || conn.closing) return;
    const silence = new Int16Array(1600);
    try {
      conn.live.send(silence);
      this.stats.audioSeconds += 0.1;
    } catch {
      this.#lost(conn, 'send failed');
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    for (const conn of [this.#current, this.#next, ...this.#draining]) if (conn) this.#shut(conn);
    this.#draining.clear();
    this.#current = null;
    this.#next = null;
    this.#buffer = [];
  }

  #log(message: string, data?: Record<string, unknown>) {
    this.handlers.onLog?.(message, { channel: this.options.label, ...data });
  }

  #keep(pcm: Int16Array) {
    this.#buffer.push(pcm);
    const max = this.timing.maxBufferMs / FRAME_MS;
    if (this.#buffer.length > max) this.#buffer.splice(0, this.#buffer.length - max);
  }

  #open(): Conn {
    const conn: Conn = {
      n: ++this.#count,
      live: null,
      readyAt: null,
      openedAt: this.now(),
      goAway: false,
      pendingFinal: '',
      lastInterim: '',
      closing: false,
    };
    const vocabulary = this.#useVocabulary ? this.options.vocabulary : [];
    this.connector(
      {
        apiKey: this.options.apiKey,
        model: this.options.model,
        config: liveConfig(vocabulary),
        timeoutMs: this.timing.setupTimeoutMs,
      },
      {
        onMessage: (m) => this.#onMessage(conn, m),
        onClose: (code, reason) => {
          if (conn.readyAt !== null) this.#onClose(conn, code, reason);
        },
      },
    ).then(
      (live) => {
        if (this.#closed || conn.closing) {
          live.close();
          return;
        }
        conn.live = live;
        conn.readyAt = this.now();
        this.#onReady(conn);
      },
      (err: unknown) => this.#onOpenFailed(conn, err instanceof Error ? err.message : String(err)),
    );
    return conn;
  }

  #connect() {
    if (this.#closed) return;
    this.#current = this.#open();
  }

  #onReady(conn: Conn) {
    if (conn === this.#current) {
      if (this.#everConnected) this.stats.reconnects++;
      this.#everConnected = true;
      this.#failures = 0;
      const backlog = this.#buffer;
      this.#buffer = [];
      try {
        for (const pcm of backlog) conn.live!.send(pcm);
      } catch {
        this.#lost(conn, 'send failed');
        return;
      }
      if (backlog.length > 0) this.#log('sent buffered audio', { ms: backlog.length * FRAME_MS });
      this.handlers.onState('connected', null);
      this.#log('connected', { connection: conn.n });
    } else if (conn === this.#next) {
      this.#log('next connection ready', { connection: conn.n });
      this.#maybeRoll();
    }
  }

  #onOpenFailed(conn: Conn, reason: string) {
    if (this.#closed || conn.closing) return;
    this.#log('connect failed', { connection: conn.n, reason: redact(reason).slice(0, 200) });
    if (conn === this.#next) {
      this.#next = null; // try again on a later frame
      return;
    }
    if (conn !== this.#current) return;
    this.#current = null;
    // Some models reject custom vocabulary: try once more without it.
    if (this.#useVocabulary && /invalid|vocabulary|1007/i.test(reason)) {
      this.#useVocabulary = false;
      this.#log('retrying without custom vocabulary');
      this.#connect();
      return;
    }
    if (isFatalLiveError(reason)) {
      this.#fatal = true;
      this.#buffer = [];
      this.handlers.onState('error', friendlyLiveError(reason));
      return;
    }
    this.#retryLater(reason);
  }

  #retryLater(reason: string) {
    const delays = this.timing.retryDelaysMs;
    const delay = delays[Math.min(this.#failures, delays.length - 1)] ?? 5_000;
    this.#failures++;
    this.handlers.onState(
      'reconnecting',
      this.#failures > 2 ? friendlyLiveError(reason) || 'Reconnecting…' : 'Reconnecting…',
    );
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => this.#connect(), delay);
  }

  #onClose(conn: Conn, code: number, reason: string) {
    if (this.#closed || conn.closing) return;
    if (conn === this.#next) {
      this.#next = null;
      return;
    }
    if (conn !== this.#current) return;
    this.#lost(conn, `closed ${code}${reason ? `: ${reason}` : ''}`);
  }

  /** The current connection is gone: switch to the next one or reconnect. */
  #lost(conn: Conn, reason: string) {
    this.#log('connection lost', { connection: conn.n, reason: redact(reason).slice(0, 200) });
    this.#flushPartial(conn);
    this.#shut(conn);
    if (this.#current === conn) this.#current = null;
    if (this.#next && this.#next.readyAt !== null) {
      this.#current = this.#next;
      this.#next = null;
      this.handlers.onState('connected', null);
      return;
    }
    if (isFatalLiveError(reason)) {
      this.#fatal = true;
      this.handlers.onState('error', friendlyLiveError(reason));
      return;
    }
    this.#retryLater(reason);
  }

  /** Keeps whatever was heard of an utterance the connection won't finish. */
  #flushPartial(conn: Conn) {
    const text = (conn.pendingFinal || conn.lastInterim).trim();
    conn.pendingFinal = '';
    conn.lastInterim = '';
    if (text) this.handlers.onFinal(text);
  }

  #shut(conn: Conn) {
    if (conn.closing) return;
    conn.closing = true;
    try {
      conn.live?.close();
    } catch {
      // already closed
    }
  }

  #maybeRoll() {
    const current = this.#current;
    if (!current || current.readyAt === null || current.closing || this.#closed) return;
    const now = this.now();
    const due = current.goAway || now - current.openedAt >= this.timing.rollAfterMs;
    if (!due) return;
    if (!this.#next) {
      this.#log('opening next connection', { goAway: current.goAway });
      this.#next = this.#open();
      return;
    }
    const next = this.#next;
    if (next.readyAt === null) return;
    const pause = this.#silentMs >= this.timing.handoverSilenceMs;
    if (!pause && now - next.readyAt < this.timing.maxHandoverWaitMs) return;

    // Switch: new audio goes to the next connection; the old one finishes its last utterance.
    this.#current = next;
    this.#next = null;
    this.stats.reconnects++;
    this.#log('switched connection', { from: current.n, to: next.n, atPause: pause });
    try {
      current.live?.endAudio();
    } catch {
      // closing anyway
    }
    this.#draining.add(current);
    setTimeout(() => {
      if (!this.#draining.delete(current)) return;
      this.#flushPartial(current);
      this.#shut(current);
    }, this.timing.drainMs);
  }

  #onMessage(conn: Conn, message: LiveServerMessage) {
    if (this.#closed) return;
    if (message.goAway) {
      conn.goAway = true;
      this.#log('server asked to reconnect', {
        connection: conn.n,
        timeLeft: message.goAway.timeLeft,
      });
      this.#maybeRoll();
    }
    const content = message.serverContent;
    const interim = content?.interimInputTranscription?.text;
    if (interim && !conn.closing) {
      conn.lastInterim = interim;
      this.handlers.onInterim(interim);
    }
    const final = content?.inputTranscription;
    if (final?.text !== undefined || final?.finished) {
      conn.pendingFinal += final.text ?? '';
      if (final.finished !== false) {
        const text = conn.pendingFinal.trim();
        conn.pendingFinal = '';
        conn.lastInterim = '';
        if (text) this.handlers.onFinal(text);
      }
    }
    const activity = message.voiceActivity?.voiceActivityType;
    if (activity === VoiceActivityType.ACTIVITY_START) this.handlers.onActivity?.(true);
    else if (activity === VoiceActivityType.ACTIVITY_END) this.handlers.onActivity?.(false);
  }
}

export class GeminiLiveStt implements SttProvider {
  constructor(
    private readonly connector: LiveConnector = geminiLiveConnector,
    private readonly timing: GeminiLiveTiming = DEFAULT_LIVE_TIMING,
    private readonly now: () => number = () => performance.now(),
  ) {}

  open(options: SttStreamOptions, handlers: SttHandlers): SttStream {
    return new GeminiLiveStream(options, handlers, this.connector, this.timing, this.now);
  }
}
