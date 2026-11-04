# AI Interview Copilot

A desktop app (Windows first, macOS later) that listens to a live job interview and streams short, natural answers grounded in your resume and your own notes.

## Status

| Phase | What | Status |
|---|---|---|
| 0 | Technical validation: last word → first answer word in **~1.0 s median** | Done ([results](docs/phase0/results.md)) |
| 1 | App foundation: Electron app, encrypted database, OS-protected keys, settings, Windows installer in CI | Done ([summary](docs/phase1/summary.md)) |
| 2 | Resume import, Application Knowledge, answer bank | Done ([summary](docs/phase2/summary.md)) |
| 3 | Live listening: audio capture, live transcription, copilot window, sessions, hotkeys | Done ([summary](docs/phase3/summary.md)); real-device test pending |
| 4 | Live answers: turn detection, streamed answers, answer bank first, Answer now / regenerate | Done ([summary](docs/phase4/summary.md)); **~1.2 s median** from last word to first answer word with real Gemini |
| 5 | Speed and quality hardening: fact check, echo cancellation, provider failover | Next |

## Docs

- [Architecture](docs/architecture.md)
- [Decision records](docs/adr/)
- [Building and releasing](docs/release.md)

## Repository

| Path | What |
|---|---|
| `apps/desktop/` | The Electron app: `src/main` (windows, secrets, IPC), `src/engine` (utility process: database, AI), `src/preload`, `src/renderer` (React UI), `e2e/` (Playwright) |
| `packages/ipc/` | Contracts between processes: IPC channels, settings schema, engine RPC, errors |
| `packages/core/` | Engine logic without Electron: Gemini provider, turn taking, audio and transcription, resume text extraction and quote checking, answer matching, logging, redaction |
| `packages/db/` | Encrypted SQLite: schema, migrations, repositories |
| `packages/prompts/` | Versioned prompts, model output schemas, Candidate Brief and knowledge compilers, recognizer vocabulary |
| `packages/native-audio/` | Rust (napi-rs) WASAPI capture module: microphone, system audio, one app |
| `evals/` | Opt-in evaluations with real Gemini (see [evals/README.md](evals/README.md)) |
| `spikes/` | Phase 0 benchmarks, fixtures and the Electron capture spike |
| `docs/` | Architecture, ADRs, phase reports, release process |

## Development

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
