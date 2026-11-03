import { readFileSync, writeFileSync } from 'node:fs';

/** Mono 16-bit PCM audio held as Int16 samples. */
export interface PcmAudio {
  sampleRate: number;
  samples: Int16Array;
}

export function encodeWav({ sampleRate, samples }: PcmAudio): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i] ?? 0, 44 + i * 2);
  return buf;
}

/** Decodes a PCM16 WAV file. Multi-channel input is down-mixed to mono. */
export function decodeWav(buf: Buffer): PcmAudio {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      if (format !== 1 || bits !== 16) throw new Error(`Unsupported WAV format ${format}/${bits}-bit (need PCM16)`);
    } else if (id === 'data') {
      const frames = Math.floor(size / (2 * channels));
      const samples = new Int16Array(frames);
      for (let f = 0; f < frames; f++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) acc += buf.readInt16LE(body + (f * channels + c) * 2);
        samples[f] = Math.round(acc / channels);
      }
      return { sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export const readWav = (path: string) => decodeWav(readFileSync(path));
export const writeWav = (path: string, audio: PcmAudio) => writeFileSync(path, encodeWav(audio));

/** Raw little-endian PCM16 bytes (e.g. Gemini TTS output) to samples. */
export function pcm16FromBytes(bytes: Buffer): Int16Array {
  const out = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2);
  return out;
}

export function pcm16ToBytes(samples: Int16Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i] ?? 0, i * 2);
  return buf;
}

/**
 * Linear-interpolation resampler. Adequate for speech fixtures and STT
 * benchmarking; the production pipeline will use a proper polyphase resampler.
 */
export function resample(audio: PcmAudio, targetRate: number): PcmAudio {
  if (audio.sampleRate === targetRate) return audio;
  const ratio = audio.sampleRate / targetRate;
  const outLen = Math.floor(audio.samples.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = audio.samples[i0] ?? 0;
    const b = audio.samples[i0 + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return { sampleRate: targetRate, samples: out };
}

/** Finds first/last sample index whose 10 ms window RMS exceeds the threshold. */
export function speechBounds(audio: PcmAudio, rmsThreshold = 500): { start: number; end: number } | null {
  const win = Math.max(1, Math.round(audio.sampleRate / 100));
  let first = -1;
  let last = -1;
  for (let s = 0; s + win <= audio.samples.length; s += win) {
    let sum = 0;
    for (let i = s; i < s + win; i++) {
      const v = audio.samples[i] ?? 0;
      sum += v * v;
    }
    if (Math.sqrt(sum / win) >= rmsThreshold) {
      if (first < 0) first = s;
      last = s + win;
    }
  }
  return first < 0 ? null : { start: first, end: last };
}

export function silence(sampleRate: number, ms: number): Int16Array {
  return new Int16Array(Math.round((sampleRate * ms) / 1000));
}

export function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
