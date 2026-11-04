/**
 * The native audio module (packages/native-audio, Rust + WASAPI). Loaded lazily
 * the first time audio is needed, so a broken or missing module never stops the
 * rest of the app from working.
 */

export interface NativeDevice {
  id: string;
  name: string;
  kind: string;
  isDefault: boolean;
}

export interface NativeAudioApp {
  pid: number;
  name: string;
  displayName: string;
  active: boolean;
}

export interface NativeCaptureOptions {
  source: 'microphone' | 'system' | 'process' | 'test-tone';
  channel: string;
  deviceId?: string;
  processId?: number;
  includeProcessTree?: boolean;
}

export interface NativeFrame {
  channel: string;
  seq: number;
  timestampMs: number;
  pcm: Uint8Array;
  filled: boolean;
  discontinuity: boolean;
}

export interface NativeCaptureEvent {
  kind: string;
  message: string;
  device?: string | null;
  sampleRate?: number | null;
  channels?: number | null;
  sampleFormat?: string | null;
  windowsConverts?: boolean | null;
}

export interface NativeCaptureSession {
  stop(): void;
  readonly running: boolean;
}

export interface NativeAudioModule {
  nowMs(): number;
  supportedSources(): string[];
  listDevices(): NativeDevice[];
  listAudioApps?(): NativeAudioApp[];
  startCapture(
    options: NativeCaptureOptions,
    onFrame: (frame: NativeFrame) => void,
    onError: (message: string) => void,
    onEvent?: (event: NativeCaptureEvent) => void,
  ): NativeCaptureSession;
}

export type NativeAudioStatus =
  | { available: true; module: NativeAudioModule; sources: string[] }
  | { available: false; error: string };

let cached: NativeAudioStatus | null = null;

/** Loads the module once; later calls return the same result. */
export function loadNativeAudio(path: string | null): NativeAudioStatus {
  if (cached) return cached;
  if (!path) {
    cached = { available: false, error: 'This build has no native audio module.' };
    return cached;
  }
  try {
    // process.dlopen instead of require: works the same bundled or not, and
    // inside app.asar.unpacked in the packaged app.
    const mod = { exports: {} as NativeAudioModule };
    process.dlopen(mod, path);
    const sources = mod.exports.supportedSources();
    cached = { available: true, module: mod.exports, sources };
  } catch (err) {
    cached = {
      available: false,
      error: `The native audio module could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return cached;
}

/** For tests. */
export function resetNativeAudioForTests(status: NativeAudioStatus | null = null): void {
  cached = status;
}
