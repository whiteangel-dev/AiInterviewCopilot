# AI Interview Copilot — Architecture

**Status:** approved 2026-11-03; speed targets validated in Phase 0 ([results](phase0/results.md)); app foundation built in Phase 1 ([summary](phase1/summary.md)); preparation pipeline built in Phase 2 ([summary](phase2/summary.md)); live listening built in Phase 3 ([summary](phase3/summary.md)); live answers built in Phase 4 ([summary](phase4/summary.md)); hardening built in Phase 5 ([summary](phase5/summary.md)); public downloads, automatic updates and free-key support built in Phase 6 ([summary](phase6/summary.md)). Real-device capture, real interviews and real speakers are still to be confirmed on a Windows PC. Individual decisions are recorded in [docs/adr/](adr/).

A Windows-first (macOS later) desktop app. It listens to a live job interview, detects the interviewer's questions, and streams short, natural answers grounded in the candidate's resume and their own notes ("Application Knowledge"). English-only.

## 1. Priorities

1. **Speed.** First answer words on screen within 1.5 s (median) of the interviewer's last word. Measured:
   - Phase 0 prototype: 0.97 s median, 1.24 s at the 95th percentile;
   - the app (Phase 4, three runs): 1.15–1.36 s median, 1.44–1.87 s at the 95th percentile. The model's time to first token varied that day; the app's own part is ~0.5 s;
   - with duplicate requests for slow responses (Phase 5): 1.23 s median, 1.46 s at the 95th percentile;
   - racing two requests, keeping answers on punctuation-only changes, and a fast path for "Tell me about…" requests (Phase 7): **1.0 s median, 1.3 s at the 95th percentile** ([ADR 0014](adr/0014-faster-answers.md)).
2. **Reliability during a live interview.** No crashes, automatic reconnection, graceful fallback.
3. **Grounded answers.** Never invent experience; handle gaps honestly.
4. **Low resource use.** Runs next to Zoom or Teams and a browser.
5. **Privacy.** Data stays on the device; keys live in the OS keychain; no audio is stored by default.

## 2. Technology

| Layer | Choice |
|---|---|
| Desktop shell | Electron (pinned to a supported major), electron-vite, electron-builder (NSIS installer), electron-updater (GitHub Releases) |
| UI | React + TypeScript + Vite, Tailwind CSS, shadcn/ui, Zustand |
| Core logic | TypeScript in `packages/core`, with no Electron imports (testable in plain Node) |
| Audio capture | Rust native module (napi-rs) using WASAPI on Windows; Swift bridge for Core Audio taps on macOS |
| Speech-to-text | Gemini Live API, `gemini-3.5-transcribe-live` |
| AI models | Gemini first (`@google/genai`), behind provider interfaces so OpenAI and Claude can be added later |
| Storage | SQLite (`better-sqlite3-multiple-ciphers`, ChaCha20-Poly1305), Drizzle ORM with embedded migrations, FTS5 keyword search, sqlite-vec |
| Secrets | Electron `safeStorage`, async API (Windows DPAPI / macOS Keychain); keys never reach the UI, database or logs |
| Tests | Vitest, a replay harness that runs recorded audio through the pipeline, AI test sets, Playwright end-to-end |

## 3. Processes

```
┌ Main window (React) ┐  ┌ Copilot window (React) ┐  ┌ Capture window (hidden) ┐
│ sandboxed renderer  │  │ sandboxed renderer     │  │ built-in capture only;  │
└─────────┬───────────┘  └───────────┬────────────┘  │ own session, no bridge  │
          │ IPC (invoke) · live events (broadcast)│  └────────────┬────────────┘
┌─────────▼────────────────────────────▼───┐                      │ MessagePort (audio frames)
│ Main process                              │       ┌──────────────▼───────────────────────────────┐
│ windows · hotkeys · updater · safeStorage ├──────►│ Engine (utilityProcess)                      │
└───────────────────────────────────────────┘ keys  │ native audio → STT → turn analyzer ∥ answer  │
                                                    │ SQLite owner · worker threads for heavy jobs │
                                                    └──────────────────────────────────────────────┘
```

- **Main process** stays light; if it blocks, every window freezes.
- **Engine** runs the whole live pipeline in an Electron `utilityProcess`. Heavy jobs (resume parsing, embeddings) run on worker threads.
- **Renderers** are sandboxed, use `contextIsolation`, have no Node.js access and a strict CSP. The packaged UI loads from `app://renderer/`, not `file://`.
- **Live events** (transcript, meters, state, answers as they stream) go from the engine through main to both windows. A direct engine → renderer MessagePort remains an option, but answer streams didn't need it ([ADR 0009](adr/0009-live-listening.md), [ADR 0010](adr/0010-live-answers.md)).
- **IPC:**
  - renderer → main uses one allowlisted `invoke` bridge; main checks the sender, validates every payload with Zod, and replies with a `Result` envelope that keeps error codes;
  - main ↔ engine uses a typed RPC (`@aic/ipc`) with timeouts and events;
  - main restarts a crashed engine with backoff. Details: [ADR 0007](adr/0007-app-foundation.md).

## 4. Live pipeline

```
Interviewer (system audio) ─┐                      ┌► interim transcript ─┐
                            ├► native audio ─► Live STT                  ├► turn analyzer ──┐ confirm / cancel
You (microphone) ───────────┘   16 kHz mono  └► local VAD: pause ≥300 ms ┘   ∥ answer stream ┴► Copilot window
                                20 ms frames                                        ▲
                         your spoken answer ─► conversation memory ───────────────────┘
```

1. **Capture.** Two channels: system audio is the interviewer and the microphone is you, which separates the speakers for free. Each channel arrives as 20 ms frames of 16 kHz mono PCM16 on one shared clock.
2. **Transcription.** One Live session per channel. End of segment after 300 ms of silence. Custom vocabulary comes from the profile (company names, technologies). The interim transcript holds the whole utterance so far.
3. **Turn detection.**
   - When local voice detection sees a pause of 300 ms or more, start an attempt.
   - Each attempt runs the **turn analyzer** (a fast model with JSON output: complete? → answer / ignore / wait → type → follow-up? → standalone rewrite) **in parallel with** a speculative answer stream.
   - Re-run the attempt whenever the transcript grows during the pause.
   - **Fast path:** if the transcript ends with "?", show the answer as soon as it streams; the analyzer can still retract it.
   - If the interviewer resumes, cancel the attempt.
   - After 1.2 s of silence, ask the analyzer again with a "silent for over a second" hint.
4. **Answer.** A streamed answer: an opening sentence the candidate can say right away, then 2–4 short bullets. Grounding rules, an honest "no experience" pattern, American conversational style. Length presets.
5. **Memory.** The interview history is append-only and includes what the candidate actually said (mic transcript), so follow-ups stay consistent with it. An answered question with no transcribed reply gets a placeholder reply, so it isn't answered again.
6. **Manual override.** "Answer now" (hotkey), regenerate (hotkey), shorter / longer, and an "Answer automatically" setting.
7. **Answer bank first.** An approved prepared answer that confidently matches is shown as it is, with no model call.
8. **Slow or failing requests** (Phase 5):
   - a live request with no text after about the session's 90th-percentile wait gets a duplicate, and the first to answer wins;
   - one that fails before any text goes to the backup model.
9. **Fact check** (Phase 5): after each generated answer, statements the profile and notes don't support are marked in the copilot, off the critical path.

Built in Phase 4 as a tested state machine (`packages/core/src/live/turns.ts`). Turn boundaries:
- a turn ends when it was answered, when the candidate spoke, or after a finished statement and a pause;
- otherwise more speech extends it.

Details: [ADR 0010](adr/0010-live-answers.md), [ADR 0011](adr/0011-hardening.md).

### Prompt layout (ordered for provider-side caching)

1. Rules (static) → 2. Session context: today's date, company, role, Candidate Brief, knowledge facts, answer rules (static per session) → 3. Interview history (append-only) → 4. Current turn (small).

Use only Gemini's automatic (implicit) caching: explicit caches *increased* latency in Phase 0.

### Model roles (configuration, discovered via the Models API)

| Role | Default | Notes |
|---|---|---|
| Transcription | `gemini-3.5-transcribe-live` | Live API, interim + final transcripts |
| Turn analyzer | `gemini-3.5-flash-lite` | Thinking `MINIMAL`, JSON schema output |
| Live answer: Speed / Balanced | `gemini-3.5-flash-lite` | Thinking `MINIMAL` |
| Live answer: Quality | `gemini-3.1-pro-preview` | About 5 s to first token; for users who accept the wait |
| Resume extraction, knowledge analysis, answer bank | Strongest available Pro model | Not latency-sensitive |
| Backup for live answers | `gemini-3.1-flash-lite` | On purpose a different model: used when the primary fails or is rate-limited |
| Background fact check | `gemini-3.5-flash-lite` | Off the critical path; 17/18 planted claims caught, 0 false alarms, ~0.85 s |

## 5. Audio capture

Built in Phase 3 ([ADR 0009](adr/0009-live-listening.md)).

- **Windows (primary):** the native module (`packages/native-audio`) opens WASAPI in shared, event-driven mode.
  - Microphone: the capture endpoint.
  - Interviewer: loopback of the output device, or **per-app loopback** (only Zoom/Teams/browser; Windows 10 2004+ / 11).
  - It asks Windows to convert to 16 kHz mono (AUTOCONVERTPCM) and falls back to converting in Rust.
  - Loopback sends no data during silence, so gaps are filled with silent frames to keep the timeline continuous.
  - Follows the default device, and reopens a device that was unplugged.
- **Fallback:** Electron's built-in capture (`getDisplayMedia` loopback + `getUserMedia`) in a hidden window with its own session; frames reach the engine over a MessagePort.
- **macOS (later):** Core Audio process taps on 14.2+, ScreenCaptureKit audio on 13.x, through a Swift module bridged into the same Rust module.
- **Echo:**
  - recommend headphones;
  - detect echo by comparing channel levels;
  - cancel echo with an adaptive filter, using system audio as the reference, plus a residual suppressor (Phase 5, [ADR 0011](adr/0011-hardening.md));
  - remove mic transcript lines that duplicate interviewer text (a backstop).
- **Transcription cost:** only speech (with 400 ms before and 800 ms after) is sent; an idle connection gets 100 ms of silence every 15 s so the service keeps it open. This roughly halves the cost of an interview hour (about $1.15 → $0.57, estimated).

## 6. Preparation pipeline (not latency-sensitive)

Built in Phase 2; details in [ADR 0008](adr/0008-preparation-pipeline.md).

- **Resume:**
  - import PDF or DOCX;
  - extract text locally;
  - the model reads the PDF directly (Word files as text) for structured extraction against a fixed `CandidateProfile` schema, with a verbatim quote for each statement;
  - quotes are checked locally (numbers must match exactly), and unverified statements are flagged;
  - you review and edit; the result is saved as an immutable profile version and compiled deterministically into a token-efficient **Candidate Brief**.
- **Application Knowledge:**
  - items are *facts* or *instructions*, in 8 categories;
  - AI can split pasted notes into items, and review them for duplicates, conflicts with the resume, unclear notes and risky instructions;
  - compiled deterministically into answer rules plus facts;
  - grouped into knowledge bases that can be selected per session.
- **Answer bank:**
  - drafts for common and role-specific questions, approved by the user;
  - matched locally (lexical, with phrasing variants) for instant answers.
- **Model:** the preparation role (default `gemini-3.1-pro-preview`). Temporary failures are retried; long jobs show progress and can be cancelled. Keys that can't use Pro (Google's free tier) fall back to `gemini-3.8-flash` ([ADR 0012](adr/0012-distribution.md)).

## 7. Data (SQLite, local, encrypted)

| Area | Tables |
|---|---|
| Profiles | `profiles`, `resume_documents`, `profile_versions` (immutable JSON + compiled brief) |
| Knowledge | `knowledge_bases`, `knowledge_items` (fact/instruction), `knowledge_compilations` (snapshot) |
| Search | `context_chunks` + FTS5 + sqlite-vec, if retrieval is needed (not yet: the whole brief and knowledge fit in the prompt) |
| Answer bank | `prepared_answers` |
| Sessions | `sessions` (pins the profile version; snapshot of the answer context and vocabulary; turn counters; model usage), `transcript_segments` (final only), `session_questions`, `session_answers` (text, status, latency, time to first token, tokens, model, prompt version, fact check) |
| Settings | `provider_configs` (key *reference* and last 4 characters only; cached model list), `app_settings` (one row per section) |

IDs are UUIDv7. Deleting a profile or knowledge base removes everything under it, and `secure_delete` overwrites the freed pages. Sessions keep a snapshot of the context they used, so they survive changes to (or deletion of) the profile. "Delete my data" removes everything. The schema version is `PRAGMA user_version`. An existing database is backed up (still encrypted) before migrating, and a database from a newer app version is refused.

The database key is 256 random bits created on first run and kept in main's secret store (`secrets.json`, each entry encrypted with `safeStorage`). If it can't be read (for example, the data was copied to another Windows account), the app offers to start fresh instead of failing silently.

## 8. Security and privacy

- **API keys:** stored only through the OS keychain and used only in the engine process. Never in the database, logs or renderers.
- **Sharing a key:** an encrypted key file (AES-256-GCM, scrypt password) with an optional end date. The key is never displayed after import, but anyone running the app could recover it, so each person should get their own revocable key ([ADR 0013](adr/0013-key-files.md)).
- **No raw audio** is stored by default. Transcripts have retention controls; export and wipe-all are available.
- **Electron hardening:**
  - sandbox and `contextIsolation`;
  - CSP served with the `app://` protocol;
  - no permissions, new windows, navigation or `<webview>`;
  - DevTools off in release builds;
  - Fuses: no `RunAsNode`, `NODE_OPTIONS` or inspect arguments; ASAR integrity and only-load-from-asar.
- **Consent:** a notice during setup about recording consent and employer policies.

## 9. Repository layout

```
apps/desktop/        Electron app: src/{main,preload,engine,renderer}, e2e/, electron-builder.yml
packages/ipc/        contracts: IPC channels, settings schema, engine RPC, errors (Zod)
packages/core/       engine logic without Electron: AI providers, model roles, logging, redaction
packages/db/         schema, generated migrations (drizzle/), repositories
packages/prompts/    versioned prompts, model output schemas, brief and knowledge compilers, vocabulary
packages/native-audio/  Rust (napi-rs) WASAPI capture module; built into apps/desktop/resources/native/
evals/               opt-in evaluations with real Gemini: turn analyzer, the whole live pipeline, fact check, echo, model roles
docs/                architecture, ADRs, phase reports, release process
spikes/              Phase 0 benchmarks and fixtures (kept as reference)
```

## 10. Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Speed spikes, provider choices, native audio module, end-to-end prototype | **Done** (real-device Windows capture test moves to Phase 3) |
| 1 | Electron app foundation, monorepo, encrypted database, keychain, settings, CI with Windows builds | **Done** ([summary](phase1/summary.md)); signing waits for a certificate |
| 2 | Resume import and extraction, Application Knowledge, answer bank | **Done** ([summary](phase2/summary.md)) |
| 3 | Audio capture on real devices, live transcription, copilot window, hotkeys | **Done** ([summary](phase3/summary.md)); real-device capture to confirm on a Windows PC |
| 4 | Turn detection + answer generation (**Windows MVP**) | **Done** ([summary](phase4/summary.md)); real-interview tuning on a Windows PC |
| 5 | Speed and quality hardening: fact check, echo cancellation, provider failover, cost per interview hour | **Done** ([summary](phase5/summary.md)); real-speaker test on a Windows PC; a second provider when a key is available |
| 6 | Windows release: public downloads (GitHub Releases), automatic updates, first-run setup, free keys. Licensing and privacy work dropped by the owner: anyone can just use it | **Done** ([summary](phase6/summary.md)); signing waits for a certificate |
| 7 | Faster answers on Windows (the main platform) | **Done** ([summary](phase7/summary.md)) |
| 8 | Phone as a second screen (iPhone and Android, in the phone's browser) | Next |
| 9 | macOS | |
| 10 | Phone-only listening (the phone's own microphone): iPhone and Android apps | |
| 11 | Practice mode, offline mode, analytics | |
