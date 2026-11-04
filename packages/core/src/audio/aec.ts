import { FFT } from './fft';
import { FRAME_SAMPLES } from './pcm';

/**
 * Acoustic echo cancellation (Phase 5) for interviews without headphones: the
 * microphone hears the interviewer through the speakers, and the copilot
 * mistakes that for the candidate. The interviewer's own audio (system
 * loopback) is the reference.
 *
 * 1. A partitioned-block frequency-domain adaptive filter (overlap-save NLMS)
 *    learns the echo path, from the speakers through the room to the
 *    microphone, and subtracts the predicted echo. Blocks are 16 ms; the
 *    filter spans 256 ms of echo delay, from 64 ms before the reference
 *    (capture timing can put the microphone ahead) to 192 ms after.
 * 2. Adaptation pauses while both sides talk, so the candidate's voice
 *    doesn't untrain the filter: once the filter knows the echo, a residual
 *    far above the expected one means the candidate is talking. A filter that
 *    keeps making things worse resets.
 * 3. A residual suppressor turns down what the filter leaves behind while
 *    only the interviewer talks. It works on the whole block, not per
 *    frequency: the output feeds speech recognition and voice detection, not
 *    a listener, and the candidate's own speech passes at full level.
 * 4. Slow clock drift between the two devices is followed by moving the
 *    window when the learned echo nears either end.
 *
 * Input and output are 20 ms frames of 16 kHz PCM16. The output lags the
 * microphone by the lookahead (64 ms) plus up to one block.
 */

const B = 256;
const N = 2 * B;
const RATE = 16_000;

export interface EchoCancellerOptions {
  /** Filter length in 16 ms blocks (default 16: 256 ms). */
  partitions?: number;
  /** How far the microphone may lead the reference, in ms (default 64). */
  lookaheadMs?: number;
  /** A reference this late is treated as silence, so the microphone never stalls (ms). */
  maxWaitMs?: number;
  /** Normalized adaptation step, 0–1 (default 0.7). */
  step?: number;
}

export interface EchoCancellerStats {
  /** Echo reduction over recent interviewer-only audio, dB: by the filter alone, and in total. */
  linearErleDb: number | null;
  erleDb: number | null;
  /** Where the filter found the echo (ms after the reference); null until it has. */
  delayMs: number | null;
  lookaheadMs: number;
  /** Blocks processed, and how many had both sides talking. */
  blocks: number;
  doubleTalkBlocks: number;
  resets: number;
}

/** Samples in a growable first-in, first-out queue. */
class Fifo {
  #buf = new Float64Array(4096);
  #start = 0;
  #end = 0;

  get length(): number {
    return this.#end - this.#start;
  }

  push(samples: ArrayLike<number>, scale = 1): void {
    if (this.#end + samples.length > this.#buf.length) {
      const live = this.#buf.subarray(this.#start, this.#end);
      const next =
        live.length + samples.length > this.#buf.length / 2
          ? new Float64Array(Math.max(this.#buf.length * 2, live.length + samples.length))
          : this.#buf;
      next.set(live, 0);
      this.#buf = next;
      this.#end -= this.#start;
      this.#start = 0;
    }
    for (let i = 0; i < samples.length; i++) this.#buf[this.#end++] = samples[i]! * scale;
  }

  take(n: number): Float64Array {
    const out = this.#buf.slice(this.#start, this.#start + n);
    this.#start += n;
    return out;
  }
}

export class EchoCanceller {
  readonly #fft = new FFT(N);
  readonly #P: number;
  readonly #mu: number;
  readonly #maxWait: number;
  #la: number;
  readonly #maxLa: number;
  #pendingShift = 0;

  readonly #Wr: Float64Array[];
  readonly #Wi: Float64Array[];
  readonly #Xr: Float64Array[];
  readonly #Xi: Float64Array[];
  /** Σ over partitions of |X_p|², per bin. */
  readonly #xPow = new Float64Array(N);
  /** Peak |x| of each reference block in the filter window (newest first). */
  readonly #xPeak: number[];
  #constrainNext = 0;

  /** Reference samples by absolute index (ring). */
  readonly #ref = new Float64Array(RATE * 4);
  #refEnd = 0;
  /** Reference samples already replaced by silence (they arrived too late). */
  #refOwed = 0;
  readonly #mic = new Fifo();
  readonly #out = new Fifo();
  #block = 0;

  #hangover = 0;
  #nearRun = 0;
  #gain = 1;
  #leak = 1;
  #diverging = 0;
  #smoothD = 0;
  #smoothE = 0;
  #sumD = 0;
  #sumE = 0;
  #sumY = 0;
  #sumOut = 0;
  #delayMs: number | null = null;
  readonly #stats = { blocks: 0, doubleTalkBlocks: 0, resets: 0 };

  // Scratch buffers.
  readonly #yr = new Float64Array(N);
  readonly #yi = new Float64Array(N);
  readonly #er = new Float64Array(N);
  readonly #ei = new Float64Array(N);

  constructor(options: EchoCancellerOptions = {}) {
    this.#P = options.partitions ?? 16;
    this.#mu = options.step ?? 0.7;
    this.#la = Math.round(((options.lookaheadMs ?? 64) * RATE) / 1000 / B);
    this.#maxLa = Math.max(this.#la, 12);
    this.#maxWait = Math.round(((options.maxWaitMs ?? 200) * RATE) / 1000);
    const zeros = () => Array.from({ length: this.#P }, () => new Float64Array(N));
    this.#Wr = zeros();
    this.#Wi = zeros();
    this.#Xr = zeros();
    this.#Xi = zeros();
    this.#xPeak = new Array<number>(this.#P).fill(0);
  }

  get stats(): EchoCancellerStats {
    const db = (a: number, b: number) =>
      a > 0 && b > 0 ? Math.round(10 * Math.log10(a / b) * 10) / 10 : null;
    return {
      linearErleDb: db(this.#sumD, this.#sumE),
      erleDb: db(this.#sumD, this.#sumOut),
      delayMs: this.#delayMs,
      lookaheadMs: Math.round((this.#la * B * 1000) / RATE),
      ...this.#stats,
    };
  }

  /** What the speakers play (the interviewer), as captured. */
  reference(pcm: Int16Array): void {
    let start = 0;
    if (this.#refOwed > 0) {
      start = Math.min(this.#refOwed, pcm.length);
      this.#refOwed -= start;
    }
    for (let i = start; i < pcm.length; i++) {
      this.#ref[this.#refEnd % this.#ref.length] = pcm[i]! / 32_768;
      this.#refEnd++;
    }
  }

  /** The microphone; returns the cleaned frames that are ready (often one, sometimes none). */
  process(pcm: Int16Array): Int16Array[] {
    this.#mic.push(pcm, 1 / 32_768);
    while (this.#mic.length >= B) {
      // A pending move of the window needs its reference too.
      const needed = (this.#block + 1 + this.#la + Math.max(0, this.#pendingShift)) * B;
      if (this.#refEnd < needed) {
        // Never hold the microphone back for long: a missing reference is silence.
        if (this.#mic.length < this.#maxWait) break;
        const missing = needed - this.#refEnd;
        for (let i = 0; i < missing; i++) {
          this.#ref[this.#refEnd % this.#ref.length] = 0;
          this.#refEnd++;
        }
        this.#refOwed += missing;
      }
      if (this.#pendingShift) this.#applyShift();
      this.#processBlock(this.#mic.take(B));
    }
    const frames: Int16Array[] = [];
    while (this.#out.length >= FRAME_SAMPLES) {
      const samples = this.#out.take(FRAME_SAMPLES);
      const frame = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        frame[i] = Math.max(-32_768, Math.min(32_767, Math.round(samples[i]! * 32_768)));
      }
      frames.push(frame);
    }
    return frames;
  }

  #refAt(i: number): number {
    return i < 0 || i >= this.#refEnd || i < this.#refEnd - this.#ref.length
      ? 0
      : this.#ref[i % this.#ref.length]!;
  }

  /** Spectrum of reference block `b` with the block before it (overlap-save). */
  #referenceSpectrum(b: number, re: Float64Array, im: Float64Array): number {
    let peak = 0;
    for (let i = 0; i < N; i++) {
      const v = this.#refAt((b - 1) * B + i);
      re[i] = v;
      im[i] = 0;
      if (i >= B) peak = Math.max(peak, Math.abs(v));
    }
    this.#fft.transform(re, im);
    return peak;
  }

  /** Adds a reference block as the newest partition, dropping the oldest. */
  #pushReference(b: number) {
    const P = this.#P;
    const oldR = this.#Xr[P - 1]!;
    const oldI = this.#Xi[P - 1]!;
    for (let k = 0; k < N; k++) this.#xPow[k]! -= oldR[k]! * oldR[k]! + oldI[k]! * oldI[k]!;
    for (let p = P - 1; p > 0; p--) {
      this.#Xr[p] = this.#Xr[p - 1]!;
      this.#Xi[p] = this.#Xi[p - 1]!;
    }
    this.#Xr[0] = oldR;
    this.#Xi[0] = oldI;
    const peak = this.#referenceSpectrum(b, oldR, oldI);
    for (let k = 0; k < N; k++) {
      this.#xPow[k] = Math.max(0, this.#xPow[k]! + oldR[k]! * oldR[k]! + oldI[k]! * oldI[k]!);
    }
    this.#xPeak.pop();
    this.#xPeak.unshift(peak);
  }

  #processBlock(d: Float64Array) {
    const P = this.#P;
    this.#pushReference(this.#block + this.#la);
    this.#stats.blocks++;

    // Echo estimate: y = last B samples of IFFT(Σ W_p X_p).
    const yr = this.#yr;
    const yi = this.#yi;
    yr.fill(0);
    yi.fill(0);
    for (let p = 0; p < P; p++) {
      const wr = this.#Wr[p]!;
      const wi = this.#Wi[p]!;
      const xr = this.#Xr[p]!;
      const xi = this.#Xi[p]!;
      for (let k = 0; k < N; k++) {
        yr[k]! += wr[k]! * xr[k]! - wi[k]! * xi[k]!;
        yi[k]! += wr[k]! * xi[k]! + wi[k]! * xr[k]!;
      }
    }
    this.#fft.transform(yr, yi, true);
    const e = new Float64Array(B);
    let pd = 0;
    let py = 0;
    let pe = 0;
    let dMax = 0;
    for (let i = 0; i < B; i++) {
      const y = yr[B + i]!;
      e[i] = d[i]! - y;
      pd += d[i]! * d[i]!;
      py += y * y;
      pe += e[i]! * e[i]!;
      dMax = Math.max(dMax, Math.abs(d[i]!));
    }

    // Is the interviewer talking, and is the candidate talking over them? Once
    // the filter knows the echo, a residual far above what's expected means the
    // candidate. Before that, only the obvious case: louder than the reference.
    // Echo can be in this block if the reference was active anywhere in the window.
    const xMax = Math.max(...this.#xPeak);
    const farActive = xMax > 0.003;
    const converged = this.#sumE > 0 && this.#sumD > 4 * this.#sumE;
    let nearTalk =
      farActive &&
      (converged
        ? // Far more left over than usual, and it's a real share of the microphone.
          pd > B * 1e-5 && pe > 4 * this.#leak * py && pe > 0.25 * pd
        : dMax > xMax);
    // "Talking over" for over 3 s is more likely a changed echo path (the
    // laptop moved): adapt to it rather than freeze.
    this.#nearRun = nearTalk ? this.#nearRun + 1 : 0;
    if (this.#nearRun > 190) nearTalk = false;
    if (nearTalk) this.#hangover = 6;
    else if (this.#hangover > 0) this.#hangover--;
    const doubleTalk = nearTalk || this.#hangover > 0;
    if (doubleTalk) this.#stats.doubleTalkBlocks++;

    // A filter that keeps making things worse has diverged: start over.
    this.#smoothD = 0.9 * this.#smoothD + pd;
    this.#smoothE = 0.9 * this.#smoothE + pe;
    if (this.#smoothD > B * 1e-6 && this.#smoothE > 2 * this.#smoothD) this.#diverging++;
    else this.#diverging = 0;
    if (this.#diverging >= 30) {
      for (let p = 0; p < P; p++) {
        this.#Wr[p]!.fill(0);
        this.#Wi[p]!.fill(0);
      }
      this.#diverging = 0;
      this.#leak = 1;
      this.#sumE = this.#sumD;
      this.#sumY = 0;
      this.#stats.resets++;
    } else if (farActive && !doubleTalk) {
      this.#adapt(e);
    }

    // How much echo the filter leaves, learned while only the interviewer talks.
    if (farActive && !doubleTalk) {
      const decay = 0.98;
      this.#sumD = decay * this.#sumD + pd;
      this.#sumE = decay * this.#sumE + pe;
      this.#sumY = decay * this.#sumY + py;
      if (this.#sumY > 1e-9) this.#leak = Math.min(1, Math.max(0.01, this.#sumE / this.#sumY));
    }
    // Over-estimated 2×: leftover echo is worse for transcription than a
    // slightly quieter candidate, whose speech is far louder than the residual.
    const residual = farActive ? 2 * this.#leak * py : 0;
    const near = Math.max(0, pe - residual);
    const target = farActive ? Math.max(0.03, Math.sqrt(near / (near + residual + 1e-10))) : 1;
    // Turn down fast, come back up a little slower.
    const next = target < this.#gain ? target : this.#gain + 0.5 * (target - this.#gain);
    const out = new Float64Array(B);
    let pout = 0;
    for (let i = 0; i < B; i++) {
      const g = this.#gain + ((next - this.#gain) * (i + 1)) / B;
      out[i] = e[i]! * g;
      pout += out[i]! * out[i]!;
    }
    this.#gain = next;
    this.#out.push(out);

    if (farActive && !doubleTalk) this.#sumOut = 0.98 * this.#sumOut + pout;
    if (++this.#block % 64 === 0) this.#trackDelay();
  }

  /** One NLMS step in the frequency domain, constraining one partition per block. */
  #adapt(e: Float64Array) {
    const P = this.#P;
    const er = this.#er;
    const ei = this.#ei;
    er.fill(0, 0, B);
    ei.fill(0);
    er.set(e, B);
    this.#fft.transform(er, ei);
    let mean = 0;
    for (let k = 0; k < N; k++) mean += this.#xPow[k]!;
    mean /= N;
    // Regularization: relative to the average power, with a floor near −80 dBFS.
    const delta = 1e-4 * mean + P * N * 1e-8;
    const mu = this.#mu;
    for (let p = 0; p < P; p++) {
      const wr = this.#Wr[p]!;
      const wi = this.#Wi[p]!;
      const xr = this.#Xr[p]!;
      const xi = this.#Xi[p]!;
      for (let k = 0; k < N; k++) {
        const norm = mu / (this.#xPow[k]! + delta);
        // conj(X) · E
        wr[k]! += norm * (xr[k]! * er[k]! + xi[k]! * ei[k]!);
        wi[k]! += norm * (xr[k]! * ei[k]! - xi[k]! * er[k]!);
      }
    }
    // Keep one partition a true linear (not circular) filter each block, in
    // turn: as good as all of them every block (measured), at 1/16 the cost.
    const c = this.#constrainNext;
    this.#constrainNext = (c + 1) % P;
    const wr = this.#Wr[c]!;
    const wi = this.#Wi[c]!;
    this.#fft.transform(wr, wi, true);
    wr.fill(0, B);
    wi.fill(0);
    this.#fft.transform(wr, wi);
  }

  /** Where the filter has found the echo; moves the window if the echo nears an end. */
  #trackDelay() {
    const P = this.#P;
    const energy = this.#Wr.map((wr, p) => {
      const wi = this.#Wi[p]!;
      let s = 0;
      for (let k = 0; k < N; k++) s += wr[k]! * wr[k]! + wi[k]! * wi[k]!;
      return s;
    });
    const total = energy.reduce((a, b) => a + b, 0);
    const peak = energy.indexOf(Math.max(...energy));
    if (total <= 0 || energy[peak]! < (4 * total) / P) {
      this.#delayMs = null;
      return;
    }
    this.#delayMs = Math.round(((peak - this.#la) * B * 1000) / RATE);
    if (peak <= 0 && this.#la < this.#maxLa) this.#pendingShift = 1;
    else if (peak >= P - 2 && this.#la > 0) this.#pendingShift = -1;
  }

  /**
   * Moves the window one block: more lookahead (+1) when the echo arrives
   * earlier than expected, less (−1) when later. Filter and history shift with it.
   */
  #applyShift() {
    const P = this.#P;
    const shift = this.#pendingShift;
    this.#pendingShift = 0;
    const rotate = (arr: Float64Array[], dir: number) => {
      if (dir > 0) {
        const last = arr.pop()!;
        last.fill(0);
        arr.unshift(last);
      } else {
        const first = arr.shift()!;
        first.fill(0);
        arr.push(first);
      }
    };
    rotate(this.#Wr, shift);
    rotate(this.#Wi, shift);
    if (shift > 0) {
      // The block that becomes newest-but-one is added now; the newest arrives next.
      this.#la++;
      this.#pushReference(this.#block + this.#la - 1);
    } else {
      this.#la--;
      // Drop the newest reference block; it is pushed again next.
      rotate(this.#Xr, -1);
      rotate(this.#Xi, -1);
      this.#xPeak.shift();
      this.#xPeak.push(0);
      this.#xPow.fill(0);
      for (let p = 0; p < P; p++) {
        const xr = this.#Xr[p]!;
        const xi = this.#Xi[p]!;
        for (let k = 0; k < N; k++) this.#xPow[k]! += xr[k]! * xr[k]! + xi[k]! * xi[k]!;
      }
    }
  }
}
