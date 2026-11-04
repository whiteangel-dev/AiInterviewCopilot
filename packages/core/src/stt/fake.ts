import type { SttHandlers, SttProvider, SttStream, SttStreamOptions } from './types';

/**
 * A transcription stand-in for development and tests: no network. Each time the
 * local voice detector hears speech it "recognizes" the next scripted line for
 * that channel, word by word, and finalizes it when the speech stops.
 */
export const FAKE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  interviewer: [
    "Hi, thanks for joining us today. How's your day going so far?",
    'To get started, can you tell me a little bit about yourself?',
    'Why are you interested in this role?',
    'Tell me about a time you had to deal with a difficult production issue.',
    'What questions do you have for us?',
  ],
  candidate: [
    "Thanks for having me. It's going well.",
    "Sure. I'm a backend engineer with about six years of experience.",
    'I like the focus on reliability and the size of the team.',
  ],
};

export interface FakeSttTiming {
  connectMs: number;
  /** Speech time per recognized word. */
  wordMs: number;
  finalDelayMs: number;
}

const DEFAULT_TIMING: FakeSttTiming = { connectMs: 150, wordMs: 160, finalDelayMs: 300 };

class FakeStream implements SttStream {
  readonly stats = { audioSeconds: 0, reconnects: 0 };
  #connected = false;
  #closed = false;
  #line = 0;
  #words: string[] | null = null;
  #speechMs = 0;
  #shown = 0;
  #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly lines: readonly string[],
    private readonly handlers: SttHandlers,
    private readonly timing: FakeSttTiming,
  ) {
    handlers.onState('connecting', null);
    this.#later(() => {
      this.#connected = true;
      handlers.onState('connected', null);
    }, timing.connectMs);
  }

  #later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      if (!this.#closed) fn();
    }, ms);
    this.#timers.add(t);
  }

  write(_pcm: Int16Array, speaking: boolean): void {
    if (this.#closed || !this.#connected) return;
    this.stats.audioSeconds += 0.02;
    if (speaking && !this.#words && this.lines.length > 0) {
      this.#words = this.lines[this.#line++ % this.lines.length]!.split(' ');
      this.#speechMs = 0;
      this.#shown = 0;
    }
    if (!this.#words) return;
    if (speaking) {
      this.#speechMs += 20;
      const shown = Math.min(
        this.#words.length,
        1 + Math.floor(this.#speechMs / this.timing.wordMs),
      );
      if (shown > this.#shown) {
        this.#shown = shown;
        this.handlers.onInterim(this.#words.slice(0, shown).join(' '));
      }
    } else {
      const text = this.#words.join(' ');
      this.#words = null;
      this.#later(() => this.handlers.onFinal(text), this.timing.finalDelayMs);
    }
  }

  close(): void {
    this.#closed = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }
}

export class FakeSttProvider implements SttProvider {
  constructor(
    private readonly scripts: Readonly<Record<string, readonly string[]>> = FAKE_SCRIPTS,
    private readonly timing: FakeSttTiming = DEFAULT_TIMING,
  ) {}

  open(options: SttStreamOptions, handlers: SttHandlers): SttStream {
    return new FakeStream(this.scripts[options.label] ?? [], handlers, this.timing);
  }
}
