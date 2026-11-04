# AI Interview Copilot

A Windows app that listens to your job interview and, about a second after each question, suggests what to say: an opening line and a few short points, based only on your own resume and notes.

## Download

**[Download for Windows 10 and 11](https://github.com/whiteangel-dev/AiInterviewCopilot/releases/latest)**: get `AI-Interview-Copilot-Setup-….exe` under **Assets**, and run it. No admin rights needed.

- **If Windows says "Windows protected your PC":** click **More info → Run anyway**. The app isn't code-signed yet.
- **Updates** download by themselves. The app asks you to restart, and never restarts during an interview.

## Get started

1. **Connect Gemini (free).** On the Home page:
   - click **Get a free key**;
   - in Google AI Studio, click **Create API key** and copy it;
   - paste it back in the app and click **Connect**.

   If someone gave you a **key file** instead, click **Someone gave you a key file? Import it**, choose the file, and type the password they sent you.
2. **Add your resume.** Go to **Profiles → Import resume** (PDF or Word), and check what it found.
3. **Optional:**
   - **Knowledge**: add what's not on your resume (project stories, salary expectations, the company you're applying to);
   - **Answer bank**: prepare answers to common questions ahead of time.
4. **Check your audio.** Go to **Audio → Start test**, then talk and play a video: both meters should move. Headphones work best.
5. **Start your interview.** Go to **Interview**, enter the company and role, and click **Start listening**. Answers appear in the small copilot window next to your call.
   - `Ctrl+Alt+Space` shows or hides it.
   - `Ctrl+Alt+Enter` answers right away.

**On your phone too:** go to Settings → **Phone screen** → On, then scan the QR code with your phone on the same Wi-Fi. The answers show in the phone's browser, with nothing to install.

**Your data:** your resume, notes and transcripts stay on your computer, and no audio is saved.

**Sharing your key:** to let someone use the app with your key, go to Settings → **Share your key** → **Create key file**:
- set a password and, if you like, an end date, then send them the file;
- send the password another way (by phone, for example).

The app never shows them the key, but it can't make the key secret from them. Give each person their own key from Google AI Studio, and delete it when they're done.

**Free keys:** everything the copilot does live works on Google's free tier, within its usage limits. A key with billing on is faster to prepare (it uses Google's strongest model) and has higher limits: about $0.57 per interview hour, estimated.

## Status

| Phase | What | Status |
|---|---|---|
| 0 | Technical validation: last word → first answer word in **~1.0 s median** | Done ([results](docs/phase0/results.md)) |
| 1 | App foundation: Electron app, encrypted database, OS-protected keys, settings, Windows installer in CI | Done ([summary](docs/phase1/summary.md)) |
| 2 | Resume import, Application Knowledge, answer bank | Done ([summary](docs/phase2/summary.md)) |
| 3 | Live listening: audio capture, live transcription, copilot window, sessions, hotkeys | Done ([summary](docs/phase3/summary.md)); real-device test pending |
| 4 | Live answers: turn detection, streamed answers, answer bank first, Answer now / regenerate | Done ([summary](docs/phase4/summary.md)); **~1.2 s median** from last word to first answer word with real Gemini |
| 5 | Hardening: duplicate and backup requests, fact check, echo cancellation, speech-only transcription, cost per session | Done ([summary](docs/phase5/summary.md)); about **$0.57 per interview hour** on your key (estimated) |
| 6 | Windows release: public downloads, automatic updates, first-run setup, free keys; key files (1.1.0) | Done ([summary](docs/phase6/summary.md)) |
| 7 | Faster answers on Windows: **about 1.0 s** from the interviewer's last word | Done ([summary](docs/phase7/summary.md)) |
| 8 | Phone as a second screen: answers on an iPhone or Android phone, in its browser (1.3.0) | Done ([summary](docs/phase8/summary.md)) |
| 9–10 | macOS, phone-only listening | Next |

## For developers

### Docs

- [Architecture](docs/architecture.md)
- [Decision records](docs/adr/)
- [Building and releasing](docs/release.md)

### Repository

| Path | What |
|---|---|
| `apps/desktop/` | The Electron app: `src/main` (windows, secrets, IPC), `src/engine` (utility process: database, AI), `src/preload`, `src/renderer` (React UI), `e2e/` (Playwright) |
| `packages/ipc/` | Contracts between processes: IPC channels, settings schema, engine RPC, errors |
| `packages/core/` | Engine logic without Electron: Gemini provider (duplicate and backup requests, usage metering, prices), turn taking, audio (voice detection, echo cancellation) and transcription, resume text extraction and quote checking, answer matching, logging, redaction |
| `packages/db/` | Encrypted SQLite: schema, migrations, repositories |
| `packages/prompts/` | Versioned prompts, model output schemas, Candidate Brief and knowledge compilers, recognizer vocabulary |
| `packages/native-audio/` | Rust (napi-rs) WASAPI capture module: microphone, system audio, one app |
| `evals/` | Opt-in evaluations with real Gemini (see [evals/README.md](evals/README.md)) |
| `spikes/` | Phase 0 benchmarks, fixtures and the Electron capture spike |
| `docs/` | Architecture, ADRs, phase reports, release process |

### Development

Requires Node.js 24+. On Linux, Electron needs a desktop session or `xvfb-run`.

```
npm install
npm run dev            # app with hot reload
npm test               # unit tests (all packages)
npm run build && npm run test:e2e   # end-to-end tests against the built app
npm run check          # lint + format + typecheck + unit tests (what CI runs first)
```

**Native audio module** (Windows capture; needs Rust): `npm run build -w @aic/native-audio` builds it into `apps/desktop/resources/native/`. Without it, the app uses Electron's built-in capture.

**Recorded audio instead of devices** (development): `AIC_AUDIO_REPLAY_INTERVIEWER=path.wav AIC_AUDIO_REPLAY_CANDIDATE=path.wav npm run dev` (16 kHz mono WAVs). Add `AIC_FAKE_PROVIDER=1` to transcribe and answer offline with scripted text.

**Other commands:**
- `npm run db:generate`: after changing `packages/db/src/schema.ts`, writes a new SQL migration. Commit it.
- `npm run dist:win`: Windows installer. See [docs/release.md](docs/release.md).

**Live AI tests** (real Gemini, a few cents):
- `AIC_LIVE_TESTS=1 npx vitest run apps/desktop/src/engine/live.test.ts` runs the whole preparation pipeline.
- `AIC_LIVE_TESTS=1 npx vitest run apps/desktop/src/engine/live-stt.test.ts` streams speech through live transcription. It needs the Phase 0 clips: `cd spikes && npm run gen-audio`.
- `npm run eval:turns` and `npm run eval:live` evaluate turn detection and live answers ([evals/README.md](evals/README.md)).

**Gemini key:** you enter it in the app under **Settings → Gemini API key**, and the app keeps it encrypted by the OS. For the Phase 0 benchmarks and the opt-in live tests (`AIC_LIVE_TESTS=1 npm test`), put it in `.env.local`:

```
cp .env.example .env.local      # then set GEMINI_API_KEY (the file is git-ignored)
```

**Never put real keys in `.env.example` or any tracked file.**

If Electron starts as plain Node (for example, from a VS Code task), unset `ELECTRON_RUN_AS_NODE`.
