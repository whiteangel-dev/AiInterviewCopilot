# Capture spike — Option A (Windows)

Tests Electron's built-in audio capture: **system audio (loopback) for the interviewer + microphone for you**, both on one 16 kHz clock. It measures dropouts, gaps, echo and CPU, and saves 16 kHz mono WAVs plus a JSON report to `recordings/`.

## Run (on a Windows 10 22H2 or Windows 11 PC)

1. Install Node.js 22 LTS or newer.
2. Copy this `capture-win` folder to the PC.
3. In the folder, run:
   ```
   npm install
   npm start
   ```

## Test checklist (about 10 minutes)

| # | Scenario | What to check |
|---|---|---|
| 1 | Headphones on. Play a YouTube interview video, speak now and then, and record about 2 minutes | Both meters move; "missing" stays near 0 ms; no "gaps>250ms" |
| 2 | Join a Zoom, Teams or Google Meet test call (or a call with a friend) and record about 3 minutes | The interviewer meter follows the call audio |
| 3 | **Speakers, no headphones.** Play audio and stay silent for 30 s | "Both active" % shows how much echo the mic picks up |
| 4 | While recording, switch the output device (plug or unplug headphones) | Does the system audio keep working? Watch the log |
| 5 | Minimize the window during a recording | Audio keeps recording (no gaps) |

After each scenario, click **Stop & save**.

## Send back

The `recordings/*-report.json` files, plus one pair of `*-interviewer.wav` / `*-mic.wav` from scenario 2. The WAVs can be run through the transcription benchmark on the dev machine:

```
cd spikes && npm run bench:stt -- --wav path/to/<stamp>-interviewer.wav
```

**Privacy:** recordings contain whatever audio was playing. Use test content, not a real interview.
