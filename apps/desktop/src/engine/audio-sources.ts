import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { FRAME_SAMPLES, SAMPLE_RATE, asInt16, readWav, startReplay, type Logger } from '@aic/core';
import type {
  AudioChannel,
  CaptureBackend,
  CapturePortMessage,
  CaptureRequest,
  SessionAudioInfo,
  Settings,
} from '@aic/ipc';
import type { NativeAudioModule, NativeCaptureEvent, NativeCaptureOptions } from './native-audio';

export interface SourceStatus {
  state: 'ok' | 'recovering' | 'error';
  /** Plain English; null when all is well. */
  message: string | null;
  /** Device or app name. */
  source: string | null;
}

export interface SourceHandlers {
  frame(pcm: Int16Array, filled: boolean): void;
  status(status: SourceStatus): void;
}

export interface RunningSource {
  stop(): void;
}

/** Captures both channels of one live run with one backend. */
export interface AudioSources {
  backend: CaptureBackend;
  /** Problems found while choosing devices (shown as warnings). */
  warnings: string[];
  /** What is being captured, for the session record. */
  describe(): SessionAudioInfo;
  start(channel: AudioChannel, handlers: SourceHandlers): RunningSource;
  /** Formats and events for diagnostics. */
  details(): Record<string, unknown>;
}

/** A MessagePort from main (Electron's MessagePortMain in the utility process). */
export interface PortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
  close(): void;
}

// ── Native (Windows WASAPI) ─────────────────────────────────────────────────

export function nativeSources(
  native: NativeAudioModule,
  audio: Settings['audio'],
  log: Logger,
): AudioSources {
  const warnings: string[] = [];
  const devices = safe(() => native.listDevices(), []);
  const names: Record<AudioChannel, string | null> = { interviewer: null, candidate: null };
  const formats: Record<string, unknown> = {};

  const mic: NativeCaptureOptions = { source: 'microphone', channel: 'candidate' };
  if (audio.microphoneId) {
    if (devices.some((d) => d.id === audio.microphoneId && d.kind === 'input')) {
      mic.deviceId = audio.microphoneId;
    } else {
      warnings.push("Your chosen microphone isn't connected, so the default microphone is used.");
    }
  }
  names.candidate = deviceName(devices, mic.deviceId, 'input');

  let interviewer: NativeCaptureOptions = { source: 'system', channel: 'interviewer' };
  if (audio.interviewerSource === 'app' && audio.appName) {
    const wanted = audio.appName.toLowerCase();
    const apps = safe(() => native.listAudioApps?.() ?? [], []).filter(
      (a) => a.name.toLowerCase() === wanted,
    );
    const app = apps.find((a) => a.active) ?? apps[0];
    if (app) {
      interviewer = {
        source: 'process',
        channel: 'interviewer',
        processId: app.pid,
        includeProcessTree: true,
      };
      names.interviewer = app.displayName || app.name;
    } else {
      warnings.push(
        `${audio.appName} isn't playing audio yet, so the copilot listens to all system audio. Join the call first to capture only that app.`,
      );
    }
  }
  if (interviewer.source === 'system') {
    if (audio.outputDeviceId) {
      if (devices.some((d) => d.id === audio.outputDeviceId && d.kind === 'output')) {
        interviewer.deviceId = audio.outputDeviceId;
      } else {
        warnings.push("Your chosen speakers aren't connected, so the default output is used.");
      }
    }
    names.interviewer = `All audio on ${deviceName(devices, interviewer.deviceId, 'output') ?? 'the default output'}`;
  }

  const options: Record<AudioChannel, NativeCaptureOptions> = {
    interviewer,
    candidate: mic,
  };

  return {
    backend: 'native',
    warnings,
    describe: () => ({ backend: 'native', ...names }),
    details: () => ({ devices: devices.length, formats }),
    start(channel, handlers) {
      const opts = options[channel];
      const label = (e: NativeCaptureEvent) =>
        opts.source === 'process' ? names.interviewer : (e.device ?? names[channel]);
      const session = native.startCapture(
        opts,
        (f) => handlers.frame(asInt16(f.pcm), f.filled),
        (message) => {
          log.warn('native capture failed', { channel, message });
          handlers.status({
            state: 'error',
            message: captureError(channel, message),
            source: null,
          });
        },
        (e) => {
          log.info('native capture event', {
            channel,
            kind: e.kind,
            message: e.message,
            sampleRate: e.sampleRate,
            channels: e.channels,
            format: e.sampleFormat,
            windowsConverts: e.windowsConverts,
          });
          if (e.kind === 'opened') {
            formats[channel] = {
              sampleRate: e.sampleRate,
              channels: e.channels,
              format: e.sampleFormat,
              windowsConverts: e.windowsConverts,
            };
          }
          if (e.device && opts.source !== 'process') names[channel] = e.device;
          if (e.kind === 'device-lost') {
            handlers.status({ state: 'recovering', message: e.message, source: label(e) });
          } else {
            handlers.status({ state: 'ok', message: null, source: label(e) });
          }
        },
      );
      return { stop: () => session.stop() };
    },
  };
}

function deviceName(
  devices: readonly { id: string; name: string; kind: string; isDefault: boolean }[],
  id: string | undefined,
  kind: 'input' | 'output',
): string | null {
  const d = id
    ? devices.find((x) => x.id === id)
    : devices.find((x) => x.kind === kind && x.isDefault);
  return d?.name ?? null;
}

function captureError(channel: AudioChannel, message: string): string {
  const what = channel === 'candidate' ? 'microphone' : 'interviewer audio';
  if (/access|denied|0x80070005/i.test(message)) {
    return `Windows blocked access to the ${what}. Check Settings → Privacy & security → Microphone ("Let desktop apps access your microphone").`;
  }
  if (/not found|no device|0x80070490/i.test(message)) {
    return `No ${what} device was found.`;
  }
  return `Couldn't capture the ${what}: ${message}`;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ── Replay (development and tests) ──────────────────────────────────────────

export function replaySources(files: {
  interviewer: string | null;
  candidate: string | null;
}): AudioSources {
  const names: Record<AudioChannel, string | null> = {
    interviewer: files.interviewer ? basename(files.interviewer) : null,
    candidate: files.candidate ? basename(files.candidate) : null,
  };
  return {
    backend: 'replay',
    warnings: [],
    describe: () => ({ backend: 'replay', ...names }),
    details: () => ({ files: names }),
    start(channel, handlers) {
      const file = files[channel];
      let samples: Int16Array = new Int16Array(FRAME_SAMPLES);
      if (file) {
        try {
          const wav = readWav(readFileSync(file));
          if (wav.sampleRate !== SAMPLE_RATE || wav.channels !== 1) {
            throw new Error('Replay files must be 16 kHz mono 16-bit WAV.');
          }
          samples = wav.samples;
        } catch (err) {
          handlers.status({
            state: 'error',
            message: err instanceof Error ? err.message : String(err),
            source: names[channel],
          });
          return { stop: () => undefined };
        }
      }
      handlers.status({ state: 'ok', message: null, source: names[channel] ?? 'Silence' });
      return startReplay(samples, (pcm, filled) => handlers.frame(pcm, filled));
    },
  };
}

// ── Electron's built-in capture (fallback) ──────────────────────────────────

const PORT_TIMEOUT_MS = 15_000;

/**
 * Electron's built-in capture runs in a hidden window (getUserMedia for the
 * microphone, getDisplayMedia loopback for system audio) and streams frames to
 * the engine over a MessagePort that main connects.
 */
export class BrowserCapture implements AudioSources {
  readonly backend = 'browser' as const;
  readonly warnings: string[] = [];
  readonly #handlers = new Map<AudioChannel, SourceHandlers>();
  readonly #names: Record<AudioChannel, string | null> = { interviewer: null, candidate: null };
  #port: PortLike | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #opened = false;
  #stopped = false;
  #frames = 0;

  constructor(
    readonly runId: string,
    private readonly emit: {
      open(request: CaptureRequest): void;
      close(runId: string): void;
    },
    private readonly log: Logger,
  ) {}

  describe(): SessionAudioInfo {
    return { backend: 'browser', ...this.#names };
  }

  details(): Record<string, unknown> {
    return { connected: this.#port !== null, frames: this.#frames };
  }

  start(channel: AudioChannel, handlers: SourceHandlers): RunningSource {
    this.#stopped = false;
    this.#handlers.set(channel, handlers);
    if (!this.#opened) {
      this.#opened = true;
      // Open once both channels have registered.
      queueMicrotask(() => this.#open());
    }
    return {
      stop: () => {
        this.#handlers.delete(channel);
        if (this.#handlers.size === 0) this.#close();
      },
    };
  }

  #open() {
    if (this.#stopped || this.#handlers.size === 0) return;
    this.emit.open({
      runId: this.runId,
      microphone: this.#handlers.has('candidate'),
      system: this.#handlers.has('interviewer'),
    });
    this.#timer = setTimeout(() => {
      if (!this.#port) this.fail('Built-in capture did not start.');
    }, PORT_TIMEOUT_MS);
  }

  #close() {
    this.#stopped = true;
    this.#opened = false;
    clearTimeout(this.#timer);
    this.emit.close(this.runId);
    this.#port?.close();
    this.#port = null;
  }

  attach(port: PortLike): void {
    if (this.#stopped) {
      port.close();
      return;
    }
    clearTimeout(this.#timer);
    this.#port?.close();
    this.#port = port;
    port.on('message', ({ data }) => this.#onMessage(data as CapturePortMessage));
    port.on('close', () => {
      if (this.#port === port && !this.#stopped) this.fail('Built-in capture stopped.');
    });
    port.start();
    this.log.info('built-in capture connected', { runId: this.runId });
  }

  fail(message: string): void {
    for (const h of this.#handlers.values()) h.status({ state: 'error', message, source: null });
  }

  #onMessage(message: CapturePortMessage) {
    const handlers = this.#handlers.get(message?.channel);
    if (!handlers) return;
    if (message.kind === 'frame' && message.pcm instanceof ArrayBuffer) {
      this.#frames++;
      handlers.frame(new Int16Array(message.pcm), false);
    } else if (message.kind === 'status') {
      if (message.device) this.#names[message.channel] = message.device;
      if (message.status === 'opened') {
        handlers.status({ state: 'ok', message: null, source: message.device });
      } else {
        this.log.warn('built-in capture problem', {
          channel: message.channel,
          status: message.status,
          message: message.message,
        });
        handlers.status({ state: 'error', message: message.message, source: message.device });
      }
    }
  }
}
