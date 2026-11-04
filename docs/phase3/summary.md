# Phase 3 — Live listening (completed 2026-11-04)

**Result:**
- **Listening:** the app listens to an interview on two channels: the call audio (interviewer) and your microphone (you).
- **Live transcript:** both channels are transcribed live and shown in a small always-on-top copilot window.
- **Suggestions:** when the interviewer asks a question in your answer bank, the copilot shows your prepared answer.
- **Saved transcripts:** every interview is saved as a transcript you can open, export or delete.

Decisions: [ADR 0009](../adr/0009-live-listening.md).

**Still to confirm on a real Windows PC:** capture from real devices. This machine has no sound card, and GitHub's Windows runners have no audio devices. See [Real-device test](#real-device-test-on-your-windows-pc).

## What was built

| Area | What |
|---|---|
| Native audio module (`packages/native-audio`) | Moved from the spike. Adds:<ul><li>a list of apps playing audio, for per-app capture;</li><li>following the default device;</li><li>recovery when a device is unplugged;</li><li>an anti-alias filter (≥ 59 dB at 10 kHz);</li><li>capture events for diagnostics;</li><li>a static C runtime.</li></ul>Built in Windows CI and shipped unpacked in the installer |
| Built-in capture (fallback) | Hidden window, own in-memory session, microphone plus system-audio loopback, 16 kHz AudioWorklet with no output device, frames over a MessagePort |
| Engine | Audio sources (native, built-in, replay); levels and voice activity; Gemini Live transcription per channel; echo detection; answer-bank suggestions; live runs (interview or audio test); sessions service |
| Live transcription | Rolls over to a new connection at a pause, before the ~9-minute limit. Reconnects with backoff and buffers up to 15 s of audio while disconnected. Custom vocabulary from your profile and notes |
| Copilot window | Frameless and always on top. Shows a transcript with words in progress, your prepared answer when one matches, meters, warnings, pause/resume and end. Hidden from screen sharing by default; doesn't take focus |
| Main window | **Interview:** setup and live view. **Sessions:** history, transcript, rename, save as Markdown, copy, delete. **Audio:** devices, call app, test with meters and transcription, "Copy diagnostics". Settings: copilot window, keyboard shortcuts. The Home checklist adds "Test your audio" and "Start an interview" |
| Hotkeys | Show or hide the copilot (`Ctrl+Alt+Space`); pause or resume (`Ctrl+Alt+P`). Configurable; conflicts reported |
| Data | Migration 3: `sessions` (with context and vocabulary snapshot) and `transcript_segments` (final text only). Crash recovery marks sessions `interrupted`; transcript retention is applied |

## Verification

| Check | Result |
|---|---|
| Unit tests | **145 pass** (Phase 2: 104), plus **14 Rust tests**. New tests cover:<ul><li>voice activity and echo detection;</li><li>WAV and replay;</li><li>Gemini Live roll-over at a pause, reconnect with buffered audio, fatal errors and the vocabulary retry (fake connector);</li><li>vocabulary;</li><li>question matching behind lead-ins;</li><li>session repository: order, crash recovery, retention, profile deletion;</li><li>live runs: echo lines dropped, unfinished words kept, a stalled source reported, segment timing, pause time excluded;</li><li>full interview flows through the engine;</li><li>hotkeys;</li><li>accelerators.</li></ul> |
| End-to-end (Playwright, built app) | **14 of 14 pass**: the 10 from Phases 1–2, plus:<ul><li>an audio test with meters and transcription;</li><li>an interview: the copilot window opens and follows the conversation, pause and resume from the copilot, end, the transcript in Sessions;</li><li>copilot and shortcut settings;</li><li>built-in capture with Chromium's fake microphone</li></ul> |
| Packaged app smoke test (Linux) | Pass; schema version 3; native module loads from `app.asar.unpacked`; 279 ms to UI ready. Windows CI now also requires the native module to load in the installed app |
| Live transcription (`AIC_LIVE_TESTS=1`, real Gemini) | Pass; see below |
| CI ([run 41781749362](https://github.com/whiteangel-dev/AiInterviewCopilot/actions/runs/41781749362)) | All jobs pass. Windows: native module built with MSVC; unit and e2e tests; installer built; the unpacked and installed apps both load the native module |

### Live transcription with real Gemini

Four interviewer questions and one candidate answer (the Phase 0 speech clips), played in real time through the whole engine: replay → voice activity → Gemini Live → saved transcript.

| Measurement | Result |
|---|---|
| Accuracy | All 4 interviewer questions word for word except "Kestrel Pay" → "KestrelPay" and "twelve" → "12"; the candidate's answer transcribed on its own channel at the same time |
| Final text after the speaker stops | 731–894 ms (Phase 0: p50 714 ms) |
| First words on screen | 0.48 s after speech starts |
| Connection lifetime | The server warns (`goAway`) at 9:00 and closes at 9:50. The app rolls over at 8:00 or at the warning, at a pause |

### Problems found and fixed

| Problem | Fix |
|---|---|
| Built-in capture sent no audio: Electron drops messages to the utility process that *transfer* ArrayBuffers | Frames are copied (640 bytes, 100/s) |
| An AudioContext needs an output device to run (no speakers, no capture) | `sinkId: { type: 'none' }`: runs without an output and can never play anything |
| "To get started, can you tell me about yourself?" scored 0.5 against "Tell me about yourself" | Live matching also tries each sentence, and each sentence without its lead-in: score 1.0 |
| Hotkeys were re-registered on every settings change when one was taken | Re-register only when the shortcuts change |

## Known limitations

- **Not yet run on real Windows audio devices** (see below). Built-in capture is the fallback if the native module misbehaves.
- **Built-in capture** uses the default microphone and all system audio (no device or app choice).
- **Both channels are transcribed for the whole interview** (cost to be measured; the app records audio seconds per channel). Turn off "Transcribe my microphone" to halve it.
- **Suggestions come only from the answer bank.** Generated answers are Phase 4.
- **Echo** is detected and duplicate lines are dropped, but not cancelled; use headphones.

## Real-device test on your Windows PC

About 10 minutes. No Node.js or Rust needed.

1. Download the installer. On GitHub, open **Actions → ci → the latest run on `main` → Artifacts → `windows-installer`**. Unzip it.
2. Run `AI-Interview-Copilot-Setup-….exe`. The app isn't signed yet, so Windows SmartScreen may warn: choose **More info → Run anyway**.
3. In the app:
   - add your Gemini key in **Settings**;
   - open **Audio** and press **Start test**;
   - wear headphones, talk, and play a YouTube video with someone speaking.
   - Check that the **Interviewer** meter moves with the video, **You** moves with your voice, and the transcript shows both.
4. Try **One app**: pick your browser (or Zoom/Teams during a test call), test again, and play a notification sound. It should *not* show on the Interviewer meter.
5. Optional:
   - unplug or switch your headphones during a test;
   - try laptop speakers without headphones (an echo warning should appear).
6. Press **Copy diagnostics** and paste the text into our chat. It lists your audio devices and test counters, and contains no audio and no transcript text.

If the meters don't move, set **Capture method** to **Built-in**, test again, and send the diagnostics for both.

## Re-run

```
npm test                                          # unit tests
npm run build -w @aic/native-audio                # native module (needs Rust; Windows for real capture)
npm run build && npm run test:e2e                 # end-to-end (fake AI and recorded audio, offline)
AIC_LIVE_TESTS=1 npx vitest run apps/desktop/src/engine/live-stt.test.ts --silent=false
```

The live transcription test needs the Phase 0 clips (`cd spikes && npm run gen-audio`).
