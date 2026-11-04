/**
 * Electron's built-in capture (the fallback when the native audio module can't
 * be used). Runs in a hidden window: records the microphone and, on Windows,
 * system audio, and streams 20 ms frames of 16 kHz PCM to the engine over the
 * MessagePort that main connected.
 */
import type { CapturePortMessage } from '@aic/ipc';

type Channel = 'interviewer' | 'candidate';

interface Request {
  runId: string;
  microphone: boolean;
  system: boolean;
}

const RATE = 16_000;
let context: AudioContext | null = null;
const streams: MediaStream[] = [];

/**
 * Frames are copied, not transferred: Electron drops messages to the utility
 * process that transfer ArrayBuffers.
 */
function send(port: MessagePort, message: CapturePortMessage): void {
  port.postMessage(message);
}

function status(
  port: MessagePort,
  channel: Channel,
  state: 'opened' | 'ended' | 'error',
  message: string,
  device: string | null,
): void {
  send(port, { kind: 'status', channel, status: state, message, device });
}

async function attach(port: MessagePort, channel: Channel, stream: MediaStream): Promise<void> {
  const ctx = context!;
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'aic-pcm', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: 'explicit',
  });
  node.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
    send(port, { kind: 'frame', channel, pcm: data });
  };
  // A muted path to the output keeps the graph running without playing anything.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  await ctx.resume();
}

function describe(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'Access was blocked by the system or a setting.';
    if (err.name === 'NotFoundError') return 'No device was found.';
    return `${err.name}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * A context with no output device: it never plays anything, and it keeps
 * running on machines with no speakers (the output device normally drives
 * audio processing).
 */
function silentContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: RATE, sinkId: { type: 'none' } } as AudioContextOptions);
  } catch {
    return new AudioContext({ sampleRate: RATE });
  }
}

async function start(port: MessagePort, request: Request): Promise<void> {
  context = silentContext();
  await context.audioWorklet.addModule('./pcm-worklet.js');

  if (request.microphone) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streams.push(mic);
      const track = mic.getAudioTracks()[0]!;
      track.onended = () =>
        status(port, 'candidate', 'error', 'The microphone was disconnected.', track.label);
      await attach(port, 'candidate', mic);
      status(port, 'candidate', 'opened', '', track.label || 'Microphone');
    } catch (err) {
      status(port, 'candidate', 'error', `Couldn't open the microphone. ${describe(err)}`, null);
    }
  }

  if (request.system) {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      streams.push(display);
      for (const t of display.getVideoTracks()) t.stop();
      const track = display.getAudioTracks()[0];
      if (!track) throw new Error("System audio capture isn't supported on this system.");
      track.onended = () => status(port, 'interviewer', 'error', 'System audio stopped.', null);
      await attach(port, 'interviewer', new MediaStream([track]));
      status(port, 'interviewer', 'opened', '', 'All system audio');
    } catch (err) {
      status(port, 'interviewer', 'error', `Couldn't capture system audio. ${describe(err)}`, null);
    }
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; request?: Request } | null;
  if (event.source !== window || data?.type !== 'aic-capture-port' || !data.request) return;
  const port = event.ports[0];
  if (!port) return;
  port.start();
  void start(port, data.request);
});

window.addEventListener('beforeunload', () => {
  for (const s of streams) for (const t of s.getTracks()) t.stop();
  void context?.close();
});
