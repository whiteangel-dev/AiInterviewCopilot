/**
 * Echo: with speakers instead of headphones, the microphone also picks up the
 * interviewer. The mic level then rises and falls with the interviewer's level;
 * in a normal conversation people take turns, so the two levels don't move together.
 */

/** Level samples per second fed to the detector (one per 100 ms). */
export const ECHO_TICKS_PER_SECOND = 10;
const WINDOW_TICKS = 12 * ECHO_TICKS_PER_SECOND;
const MAX_LAG_TICKS = 2;
/** The interviewer must have been talking for this long within the window. */
const MIN_ACTIVE_TICKS = 3 * ECHO_TICKS_PER_SECOND;
const ON_CORRELATION = 0.65;
const OFF_CORRELATION = 0.35;

export class EchoDetector {
  readonly #interviewer: number[] = [];
  readonly #candidate: number[] = [];
  #suspected = false;
  #correlation = 0;

  get suspected(): boolean {
    return this.#suspected;
  }

  /** The latest correlation between the channels' levels (−1…1), for diagnostics. */
  get correlation(): number {
    return this.#correlation;
  }

  /**
   * Feeds one tick: each channel's average level (dBFS) over the last 100 ms
   * and whether the interviewer is talking. Returns true when `suspected` changed.
   */
  push(interviewerDb: number, candidateDb: number, interviewerSpeaking: boolean): boolean {
    this.#interviewer.push(interviewerSpeaking ? interviewerDb : Number.NaN);
    this.#candidate.push(candidateDb);
    if (this.#interviewer.length > WINDOW_TICKS) {
      this.#interviewer.shift();
      this.#candidate.shift();
    }
    const active = this.#interviewer.filter((v) => !Number.isNaN(v)).length;
    if (active < MIN_ACTIVE_TICKS) return false;

    let best = -1;
    for (let lag = -MAX_LAG_TICKS; lag <= MAX_LAG_TICKS; lag++) {
      best = Math.max(best, this.#correlate(lag));
    }
    this.#correlation = best;
    const before = this.#suspected;
    if (!this.#suspected && best >= ON_CORRELATION) this.#suspected = true;
    else if (this.#suspected && best <= OFF_CORRELATION) this.#suspected = false;
    return before !== this.#suspected;
  }

  /** Pearson correlation over ticks where the interviewer talks; mic shifted by `lag`. */
  #correlate(lag: number): number {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < this.#interviewer.length; i++) {
      const j = i + lag;
      const x = this.#interviewer[i]!;
      if (Number.isNaN(x) || j < 0 || j >= this.#candidate.length) continue;
      xs.push(x);
      ys.push(this.#candidate[j]!);
    }
    if (xs.length < MIN_ACTIVE_TICKS / 2) return 0;
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const mx = mean(xs);
    const my = mean(ys);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i]! - mx;
      const dy = ys[i]! - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    // A flat mic level (e.g. muted) can't be an echo of a varying interviewer.
    if (sxx < 1e-6 || syy < 1e-6) return 0;
    return sxy / Math.sqrt(sxx * syy);
  }
}

const words = (text: string) => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/** Word-overlap similarity (Dice coefficient, 0–1) between two transcript lines. */
export function transcriptSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const w of wb) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of wa) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      common++;
      counts.set(w, n - 1);
    }
  }
  return (2 * common) / (wa.length + wb.length);
}
