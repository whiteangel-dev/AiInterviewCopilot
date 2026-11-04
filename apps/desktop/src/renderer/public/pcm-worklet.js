// AudioWorklet for Electron's built-in capture: mixes to mono and posts 20 ms
// frames of 16-bit PCM. The AudioContext runs at 16 kHz, so Chromium has
// already resampled the device audio.
/* global AudioWorkletProcessor, registerProcessor */
const FRAME = 320;

class AicPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const a = input[0];
      const b = input[1];
      for (let i = 0; i < a.length; i++) {
        const v = b ? (a[i] + b[i]) / 2 : a[i];
        this.frame[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
        if (this.n === FRAME) {
          const out = this.frame;
          this.port.postMessage(out.buffer, [out.buffer]);
          this.frame = new Int16Array(FRAME);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('aic-pcm', AicPcm);
