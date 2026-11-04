/** In-place radix-2 complex FFT (forward unnormalized; inverse divides by n). */
export class FFT {
  readonly #cos: Float64Array;
  readonly #sin: Float64Array;
  readonly #rev: Uint32Array;

  constructor(readonly n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.#cos = new Float64Array(n / 2);
    this.#sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.#cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.#sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const bits = Math.log2(n);
    this.#rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.#rev[i] = r;
    }
  }

  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.#rev[i]!;
      if (j > i) {
        let t = re[i]!;
        re[i] = re[j]!;
        re[j] = t;
        t = im[i]!;
        im[i] = im[j]!;
        im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.#cos[k * step]!;
          const wi = sign * this.#sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] = re[i]! / n;
        im[i] = im[i]! / n;
      }
    }
  }
}
