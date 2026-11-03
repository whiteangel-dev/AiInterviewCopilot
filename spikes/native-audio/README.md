# aic-native-audio — Rust capture module (Option B)

A napi-rs module that captures one source per session on its own thread and delivers **20 ms frames of 16 kHz mono PCM16** to JavaScript.

| Source | Platform | How |
|---|---|---|
| `microphone` | Windows | WASAPI capture endpoint |
| `system` | Windows | WASAPI loopback of an output device (everything the PC plays) |
| `process` | Windows 10 2004+ / 11 | Per-app loopback (for example only Zoom, Teams or the browser), including child processes |
| `test-tone` | all | 440 Hz tone, for testing the JS plumbing |

```js
const audio = require('./aic_native_audio.node');
audio.listDevices();                       // [{ id, name, kind: 'input'|'output', isDefault }]
const s = audio.startCapture(
  { source: 'system', channel: 'interviewer' },  // deviceId? processId? includeProcessTree?
  (frame) => {},                                 // { channel, seq, timestampMs, pcm: Buffer(640), filled, discontinuity }
  (message) => {},                               // fatal error; the session has stopped
);
s.stop();
```

## Build and test

Requires Rust (stable) and Node.js.

```
npm run build     # cargo build --release → aic_native_audio.node
npm test          # Rust unit tests (frame assembler)
npm run smoke     # test tone; on Windows also records 5 s of mic + system audio to recordings/
node smoke.mjs --seconds 30 --pid <zoom/teams pid>   # longer test with per-app capture
```

## Status

The Windows code type-checks against `x86_64-pc-windows-msvc`, and CI builds it on a Windows runner. It hasn't been run against real audio devices yet; that is Phase 3, task 1.
