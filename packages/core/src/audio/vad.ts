import { FRAME_MS } from './pcm';

export interface VadOptions {
  /** Speech must be at least this loud (dBFS), whatever the noise floor. */
  minSpeechDb?: number;
  /** Speech must be this far above the noise floor. */
  marginDb?: number;
  /** Loud frames in a row before speech starts. */
  onsetMs?: number;
  /** Quiet time before speech ends. */
  hangoverMs?: number;
}

/** Frames per noise-floor block (100 ms) and blocks remembered (4 s). */
const BLOCK_FRAMES = 5;
const FLOOR_BLOCKS = 40;

/**
 * Energy-based voice activity detection with an adaptive noise floor. Cheap
 * (a few comparisons per 20 ms frame) and good enough to tell talking from
 * silence; the transcription service decides what was said.
 *
 * The noise floor is the quietest 100 ms block of the last 4 s ("minimum
 * statistics"): speech always has short gaps, so the floor stays at the
 * background level while someone talks, and adapts to a noisier room within seconds.
 */
export class VoiceActivityDetector {
  readonly #minSpeechDb: number;
  readonly #marginDb: number;
  readonly #onsetFrames: number;
  readonly #hangoverFrames: number;
  #floor = -70;
  #blockMin = Number.POSITIVE_INFINITY;
  #blockFrames = 0;
  readonly #mins: number[] = [];
  #loud = 0;
  #quiet = 0;
  #speaking = false;

  constructor(options: VadOptions = {}) {
    this.#minSpeechDb = options.minSpeechDb ?? -50;
    this.#marginDb = options.marginDb ?? 12;
    this.#onsetFrames = Math.max(1, Math.round((options.onsetMs ?? 60) / FRAME_MS));
    this.#hangoverFrames = Math.max(1, Math.round((options.hangoverMs ?? 300) / FRAME_MS));
  }

  get speaking(): boolean {
    return this.#speaking;
  }

  get noiseFloorDb(): number {
    return this.#floor;
  }

  /** Feeds one frame's level. Returns true when `speaking` changed. */
  push(db: number): boolean {
    this.#blockMin = Math.min(this.#blockMin, db);
    if (++this.#blockFrames === BLOCK_FRAMES) {
      this.#mins.push(this.#blockMin);
      if (this.#mins.length > FLOOR_BLOCKS) this.#mins.shift();
      this.#blockMin = Number.POSITIVE_INFINITY;
      this.#blockFrames = 0;
      this.#floor = Math.min(-30, Math.max(-100, Math.min(...this.#mins) + 2));
    }

    const threshold = Math.max(this.#minSpeechDb, this.#floor + this.#marginDb);
    if (!this.#speaking) {
      this.#loud = db >= threshold ? this.#loud + 1 : 0;
      if (this.#loud >= this.#onsetFrames) {
        this.#speaking = true;
        this.#quiet = 0;
        return true;
      }
    } else {
      // Hysteresis: once talking, a slightly quieter frame still counts as speech.
      this.#quiet = db >= threshold - 4 ? 0 : this.#quiet + 1;
      if (this.#quiet >= this.#hangoverFrames) {
        this.#speaking = false;
        this.#loud = 0;
        return true;
      }
    }
    return false;
  }
}
