# @aic/native-audio

A Rust (napi-rs) Node module that captures audio and hands it to JavaScript as **20 ms frames of 16 kHz mono 16-bit PCM**. Each capture session runs on its own thread and captures one source.

| Source       | Platform              | What it captures                                                                |
| ------------ | --------------------- | ------------------------------------------------------------------------------- |
| `microphone` | Windows               | A microphone (WASAPI capture endpoint)                                          |
| `system`     | Windows               | Everything an output device plays (WASAPI loopback)                             |
| `process`    | Windows 10 2004+ / 11 | One app, such as Zoom, Teams or a browser, including its child processes        |
| `test-tone`  | all                   | A 440 Hz tone at -12 dBFS, for testing the JavaScript side on any machine       |

## JavaScript API

```ts
nowMs(): number                         // module clock in ms (frame timestamps use it)
supportedSources(): string[]            // ['test-tone'] or, on Windows, also 'microphone', 'system', 'process'
listDevices(): AudioDevice[]            // { id, name, kind: 'input' | 'output', isDefault }; [] off Windows
listAudioApps(): AudioApp[]             // { pid, name, displayName, active }; [] off Windows

startCapture(
  options: { source: string; channel: string; deviceId?: string; processId?: number; includeProcessTree?: boolean },
  onFrame: (frame: AudioFrame) => void,  // { channel, seq, timestampMs, pcm: Buffer(640), filled, discontinuity }
  onError: (message: string) => void,    // fatal start-up error; the session has stopped
  onEvent?: (event: CaptureEvent) => void,
): CaptureSession                        // { stop(): void; readonly running: boolean }
```

`CaptureEvent` is `{ kind, message, device?, sampleRate?, channels?, sampleFormat?, windowsConverts? }`:

- `opened`: a device stream started. Sent after every successful open or reopen, with the device name and its format (`sampleFormat` is `'i16' | 'i32' | 'f32'`; `windowsConverts` is true when Windows itself converts to 16 kHz mono). The test tone sends one `opened` event too.
- `device-changed`: the default device changed and capture moved to the new one.
- `device-lost`: the device stopped working (for example it was unplugged).
- `reopened`: capture works again after `device-lost`.

`device-changed` and `reopened` are followed by `opened`.

`listAudioApps()` lists apps that have an audio session on any active output device. `pid` is the app's top process (the topmost parent with the same executable), so pass it as `processId` with `includeProcessTree` left on (the default). That covers browsers and Teams, which play audio from child processes. Our own app is left out.

## Behaviour on Windows

- **Format.** The module first asks Windows to deliver 16 kHz mono PCM16 directly. If the device refuses, it takes the device's own format, mixes it down to mono and resamples it. When the input rate is above 16 kHz, a low-pass filter runs before resampling so sound above 8 kHz doesn't fold back into the speech band.
- **Default device follows the system.** With no `deviceId`, the module checks the default device about once a second. When it changes (say a headset is plugged in), capture moves to the new device and sends `device-changed`.
- **Lost devices don't end the session.** If reading fails after a good start (for example the device was unplugged), or a microphone sends nothing for 3 s, the module sends `device-lost`. It then sends silent frames marked `filled: true` every 20 ms and tries to reopen about once a second: the default device, the same `deviceId`, or the same process. It sends `reopened` when that works.
- **Only start-up problems are fatal.** These are an unknown source, `process` without `processId`, COM initialisation, or a first open that fails. They go to `onError` once and the session stops.
- **The timeline stays continuous.** Loopback delivers nothing while nothing plays, so after 100 ms without data the gap is filled with silent `filled` frames. Frame count tracks wall-clock time (20 ms per frame) across reopens. A gap longer than 10 s (for example the PC slept) is skipped instead, and the next frame has `discontinuity: true`.
- The audio thread never waits for JavaScript, because every callback is non-blocking. COM work runs on the capture thread or on a short-lived worker thread, never on the JavaScript thread.
- The C runtime is linked statically (`.cargo/config.toml`), so the `.node` file doesn't need the Visual C++ Redistributable.

## Build and test

Needs Rust (stable) and Node.js 24.

```
npm run build   # cargo build --release, then copies the library to ./aic_native_audio.node
                # and ../../apps/desktop/resources/native/<platform>-<arch>/aic_native_audio.node
npm test        # Rust unit tests: frame assembly, resampling filter, app grouping
npm run smoke   # test tone, events and errors; on Windows also 5 s of mic + system audio to recordings/
node smoke.mjs --seconds 30 --app zoom   # longer run plus per-app capture (or --pid <pid>)
```

## Status

The Windows code compiles, and in Phase 0 the module loaded and passed the smoke test on a Windows CI runner, which has no audio devices. **None of it has been tested with real audio devices yet.** That includes device switching, unplug recovery and `listAudioApps()`.
