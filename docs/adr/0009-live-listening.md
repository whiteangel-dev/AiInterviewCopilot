# ADR 0009 — Live listening: capture, transcription, sessions, copilot window

- **Status:** Accepted (2026-11-04). Built in Phase 3; capture on real Windows devices is still to be confirmed on a user's PC.

## Context
Phase 3 makes the app listen to a real interview: both sides of the call, transcribed live, shown in a small window next to the call app, and saved as a transcript. Answer generation (Phase 4) will build on this pipeline, so its timing and reliability matter now.

## Decision

### Capture
- **Two channels:** `interviewer` (what the PC plays) and `candidate` (the microphone). They are captured separately, so the speakers never need to be told apart.
- **Three capture methods,** chosen in Settings → Audio (`auto` picks native when it works):
  - **Native** (`packages/native-audio`, Rust + WASAPI):
    - microphone, all system audio, or only one app (per-app loopback, Windows 10 2004+);
    - follows the default device when it changes;
    - keeps the timeline going (silent frames) while a device is unplugged, and reopens it.
  - **Built-in** (Electron), the fallback:
    - a hidden window in its own in-memory session (media permission only there, audio only);
    - `getUserMedia` for the microphone and `getDisplayMedia` loopback for system audio;
    - an AudioWorklet in a 16 kHz `AudioContext` with no output device (`sinkId: none`), so it works on PCs without speakers and never plays anything;
    - frames reach the engine over a MessagePort that main connects.
  - **Replay** (development and tests only, via environment variables): WAV files played in real time.
- **The native module is loaded lazily** (`process.dlopen`) the first time audio is needed. A broken module can't stop the app from starting, and the app falls back to built-in capture.
- **The engine computes levels and voice activity** for each 20 ms frame:
  - voice activity uses an adaptive noise floor (the quietest 100 ms of the last 4 s);
  - it drives the meters, segment timing and reconnect timing.

### Transcription
- **One Gemini Live connection per channel** (`gemini-3.5-transcribe-live`):
  - TEXT responses, `en-US`;
  - custom vocabulary built from the profile and notes: name, employers, projects, technologies, schools, and name-like words in the notes, up to 100 terms;
  - end of segment after 300 ms of silence; `NO_INTERRUPTION`.
- **Connection lifetime, measured:** the server sends `goAway` after about 9 minutes and closes the connection 50 s later. Session resumption is accepted but sends no handles for this model.
- **So the stream rolls over:**
  - after 8 minutes, or on `goAway`, it opens the next connection in the background;
  - it switches at the next pause (at least 200 ms of silence, or after at most 15 s);
  - the old connection may finish its last utterance for 4 s.
  - Transcription keeps no conversation state, so nothing is lost.
- **Dropped connections:**
  - reconnect with backoff (0.25 s up to 5 s), retrying for as long as the interview lasts;
  - up to 15 s of audio is buffered and sent after reconnecting;
  - words heard but not finalized are kept.
- **Errors a reconnect can't fix** (a bad key, an unavailable model) stop that channel with a clear message.
- **A setup rejected for its vocabulary** is retried once without vocabulary.
- **Interim text** (the utterance so far) is shown greyed out and never saved. **Final segments** are saved.

### Echo
- **Level correlation:** when the microphone level follows the interviewer's level (correlation ≥ 0.65 within ±200 ms over 12 s while the interviewer talks), the app warns: "use headphones".
- **Repeated lines:** a microphone line that repeats a recent interviewer line (≥ 75% word overlap within 8 s) is dropped and counted.

### Sessions
- **One live run at a time:** an interview, or an audio test that saves nothing.
- **An interview stores** `sessions` plus `transcript_segments` (final text only; never audio). Each session keeps a snapshot of the answer context and vocabulary, plus the profile and knowledge base names, so it stays meaningful after they change or are deleted.
- **Listening time** excludes pauses. It is saved every 10 s, so a crash loses little. Sessions left `live` after a crash are marked `interrupted` at the next start.
- **Transcripts follow the retention setting:** they are deleted when older, checked at start and every 6 hours.
- **Export:** Markdown or text, through a save dialog in main, or copied to the clipboard.

### Answer-bank suggestions
- **When the interviewer finishes a segment,** the interviewer's words since the candidate last spoke (up to 3 segments) are matched against the answer bank.
- **Matching** scores the whole text, each sentence, and each sentence without its lead-in ("To get started, …").
- **Approved answers come first;** a draft is shown only if no approved answer matches, and it is labeled "Draft".

### Copilot window
- **Window behavior:**
  - frameless and always on top (it stays above full-screen apps), with its own saved position and size;
  - shown without taking focus, and not in the taskbar;
  - closing it only hides it.
- **Hidden from screen sharing by default** (`setContentProtection`): it shows the user's resume details and notes.
- **Settings:** opacity, text size, always on top, show at start.
- **Global shortcuts,** configurable:
  - show or hide the copilot: `Ctrl+Alt+Space`;
  - pause or resume listening: `Ctrl+Alt+P`.
- **Shortcut rules:**
  - a shortcut needs a modifier other than Shift;
  - a shortcut another app owns is reported as "In use";
  - shortcuts are re-registered only when they change.

### Events to the windows
Live events reach the windows through main (`broadcast`), not a direct engine → renderer MessagePort as [§3 of the architecture](../architecture.md#3-processes) planned:
- **Volume is small:** meters at 10/s, interim text a few times per second.
- **Main stays light:** its handler only forwards.
- **One path:** the same allowlisted event channels serve both windows.

The direct port remains an option if Phase 4's token streaming shows measurable delay. Audio frames from the built-in capture do use a direct MessagePort, because they are 100 messages/s.

## Evidence

| Measurement | Result |
|---|---|
| Real Gemini, full engine pipeline, real-time replay of 4 interviewer questions + 1 candidate answer | Interviewer text matches the script except "KestrelPay" and "12"; final text 0.73–0.89 s after speech ends; first interim 0.48 s after speech starts; both channels in parallel |
| Live connection lifetime | `goAway` (50 s left) at 540 s; closed with 1008 at 590 s |
| Built-in capture (Chromium fake devices) | Microphone frames reach the engine; echo warning fires when both channels carry the same sound |
| Packaged app (Linux) | Native module loads from `app.asar.unpacked`; UI ready in 279 ms |

## Consequences
- **Real-device validation is the user's first step,** using the installer from CI, the Audio page and "Copy diagnostics":
  - WASAPI formats and Windows' conversion;
  - per-app capture of Zoom, Teams and browsers;
  - unplugging headphones;
  - echo with laptop speakers.
- **Cost:** transcription runs on both channels for the whole interview. This model reports no token usage, so the app records audio seconds per channel for later cost estimates.
- **Phase 4:**
  - the turn analyzer and answer generation plug into the final and interim events, voice activity and the session context snapshot;
  - the `answerNow` hotkey joins the hotkey list.
