import { FRAME_MS, FRAME_SAMPLES } from './pcm';

/**
 * Plays recorded 16 kHz mono samples as live 20 ms frames, paced against the
 * wall clock (catching up after timer delays). After the recording ends it
 * sends silence, like a live channel would, unless `loop` is set.
 * Used in development and tests in place of a microphone or system audio.
 */
export function startReplay(
  samples: Int16Array,
  onFrame: (pcm: Int16Array, filled: boolean) => void,
  options: { loop?: boolean; now?: () => number } = {},
): { stop(): void } {
  const now = options.now ?? (() => performance.now());
  const total = Math.floor(samples.length / FRAME_SAMPLES);
  const silence = new Int16Array(FRAME_SAMPLES);
  const t0 = now();
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const frameAt = (n: number): Int16Array => {
    const i = options.loop && total > 0 ? n % total : n;
    return i < total ? samples.slice(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES) : silence.slice();
  };

  const tick = () => {
    if (stopped) return;
    const elapsed = now() - t0;
    const due = Math.floor(elapsed / FRAME_MS);
    while (sent < due && !stopped) {
      onFrame(frameAt(sent), !options.loop && sent >= total);
      sent++;
    }
    timer = setTimeout(tick, FRAME_MS - (elapsed % FRAME_MS) + 1);
  };
  timer = setTimeout(tick, FRAME_MS);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
