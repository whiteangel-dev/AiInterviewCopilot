import type { SttState } from '@aic/ipc';

export interface SttStreamOptions {
  apiKey: string;
  model: string;
  /** Names and terms the recognizer should prefer (companies, technologies). */
  vocabulary: readonly string[];
  /** For logs, e.g. the channel name. */
  label: string;
}

export interface SttHandlers {
  /** The current utterance so far (each call replaces the previous one). */
  onInterim(text: string): void;
  /** A finished utterance. */
  onFinal(text: string): void;
  /** Connection state; `detail` explains errors and reconnects in plain English. */
  onState(state: SttState, detail: string | null): void;
  /** The service's own speech start/end signal, when it sends one. */
  onActivity?(speaking: boolean): void;
  /** Diagnostics (no transcript text). */
  onLog?(message: string, data?: Record<string, unknown>): void;
}

/** One continuous transcription stream for one audio channel. */
export interface SttStream {
  /**
   * Sends one 20 ms frame of 16 kHz mono PCM16. `speaking` is the local voice
   * detector's verdict, used to time reconnects at pauses.
   */
  write(pcm: Int16Array, speaking: boolean): void;
  close(): void;
  readonly stats: { audioSeconds: number; reconnects: number };
}

export interface SttProvider {
  open(options: SttStreamOptions, handlers: SttHandlers): SttStream;
}
