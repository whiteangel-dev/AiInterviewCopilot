/** The pipeline's canonical audio: 20 ms frames of 16 kHz mono 16-bit PCM. */
export const SAMPLE_RATE = 16_000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
/** Level reported for digital silence. */
export const SILENCE_DB = -100;

/** RMS level of a frame in dBFS, floored at −100. */
export function levelDb(pcm: Int16Array): number {
  if (pcm.length === 0) return SILENCE_DB;
  let sum = 0;
  for (const s of pcm) sum += s * s;
  const rms = Math.sqrt(sum / pcm.length) / 32_768;
  return rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
}

/** Views a Node Buffer or ArrayBuffer of little-endian PCM16 as samples (copies if unaligned). */
export function asInt16(data: ArrayBuffer | Uint8Array): Int16Array {
  if (data instanceof Uint8Array) {
    if (data.byteOffset % 2 === 0) {
      return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
    }
    return new Int16Array(data.slice().buffer, 0, Math.floor(data.byteLength / 2));
  }
  return new Int16Array(data, 0, Math.floor(data.byteLength / 2));
}

export function pcmToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}

export interface Wav {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}

/** Reads a 16-bit PCM WAV file's samples (interleaved if multi-channel). */
export function readWav(bytes: Uint8Array): Wav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let format: { channels: number; sampleRate: number; bits: number; audioFormat: number } | null =
    null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data before format');
      if (format.audioFormat !== 1 || format.bits !== 16) {
        throw new Error('Only 16-bit PCM WAV files are supported');
      }
      const end = Math.min(body + size, bytes.byteLength);
      const copy = bytes.slice(body, end - ((end - body) % 2));
      return {
        sampleRate: format.sampleRate,
        channels: format.channels,
        samples: new Int16Array(copy.buffer),
      };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data');
}

export function encodeWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(out.buffer);
  const write = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.byteLength, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.byteLength, true);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44);
  return out;
}

/** A sine tone (for tests and synthetic fixtures). */
export function tone(ms: number, hz: number, dbfs: number, sampleRate = SAMPLE_RATE): Int16Array {
  const n = Math.round((sampleRate * ms) / 1000);
  const amp = 32_767 * 10 ** (dbfs / 20) * Math.SQRT2;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++)
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / sampleRate));
  return out;
}
