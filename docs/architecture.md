# AI Interview Copilot — Architecture

**Status:** approved 2026-11-03; speed targets validated in Phase 0 ([results](phase0/results.md)); app foundation built in Phase 1 ([summary](phase1/summary.md)); preparation pipeline built in Phase 2 ([summary](phase2/summary.md)). Individual decisions are recorded in [docs/adr/](adr/).

A Windows-first (macOS later) desktop app. It listens to a live job interview, detects the interviewer's questions, and streams short, natural answers grounded in the candidate's resume and their own notes ("Application Knowledge"). English-only.

## 1. Priorities

1. **Speed.** First answer words on screen within 1.5 s (median) of the interviewer's last word. Measured: 0.97 s median, 1.24 s at the 95th percentile.
2. **Reliability during a live interview.** No crashes, automatic reconnection, graceful fallback.
3. **Grounded answers.** Never invent experience; handle gaps honestly.
4. **Low resource use.** Runs next to Zoom or Teams and a browser.
5. **Privacy.** Data stays on the device; keys live in the OS keychain; no audio is stored by default.

## 2. Technology

| Layer | Choice |
|---|---|
| Desktop shell | Electron (pinned to a supported major), electron-vite, electron-builder (NSIS installer, auto-update) |
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
┌ Main window (React) ┐       ┌ Copilot window (React) ┐
│ sandboxed renderer  │       │ sandboxed renderer     │
└─────────┬───────────┘       └───────────┬────────────┘
          │ IPC (invoke)                  │ direct MessagePort (transcript, answer tokens)
┌─────────▼───────────┐                   │
│ Main process        │       ┌───────────▼──────────────────────────────────┐
│ windows · tray ·    │ keys  │ Engine (utilityProcess)                      │
│ hotkeys · updater · ├──────►│ native audio → STT → turn analyzer ∥ answer  │
│ safeStorage         │       │ SQLite owner · worker threads for heavy jobs │
└─────────────────────┘       └──────────────────────────────────────────────┘
```

- **Main process** stays light; if it blocks, every window freezes.
- **Engine** runs the whole live pipeline in an Electron `utilityProcess`. Heavy jobs (resume parsing, embeddings) run on worker threads.
- **Renderers** are sandboxed, use `contextIsolation`, have no Node.js access and a strict CSP. The packaged UI loads from `app://renderer/`, not `file://`.
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
5. **Memory.** The interview history is append-only and includes what the candidate actually said (mic transcript), so follow-ups stay consistent with it.
6. **Manual override.** Hotkeys: "Answer now", regenerate, shorter / longer.

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
| Background fact check, summaries | `gemini-3.5-flash-lite` | Off the critical path |

## 5. Audio capture

- **Windows (primary):** the native module opens WASAPI in shared, event-driven mode.
  - Microphone: the capture endpoint.
  - Interviewer: loopback of the output device, or **per-app loopback** (only Zoom/Teams/browser; Windows 10 2004+ / 11).
  - It asks Windows to convert to 16 kHz mono (AUTOCONVERTPCM) and falls back to converting in Rust.
  - Loopback sends no data during silence, so gaps are filled with silent frames to keep the timeline continuous.
- **Fallback:** Electron's built-in capture (`getDisplayMedia` loopback + `getUserMedia`).
- **macOS (later):** Core Audio process taps on 14.2+, ScreenCaptureKit audio on 13.x, through a Swift module bridged into the same Rust module.
- **Echo:**
  - recommend headphones;
  - detect echo by comparing channel activity;
  - cancel echo later using system audio as the reference;
  - remove mic transcript lines that duplicate interviewer text.

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
- **Model:** the preparation role (default `gemini-3.1-pro-preview`). Temporary failures are retried; long jobs show progress and can be cancelled.

## 7. Data (SQLite, local, encrypted)

| Area | Tables |
|---|---|
| Profiles | `profiles`, `resume_documents`, `profile_versions` (immutable JSON + compiled brief) |
| Knowledge | `knowledge_bases`, `knowledge_items` (fact/instruction), `knowledge_compilations` (snapshot) |
| Search | `context_chunks` + FTS5 + sqlite-vec, if retrieval is needed (Phase 4; the whole brief and knowledge currently fit in the prompt) |
| Answer bank | `prepared_answers` |
| Sessions | `sessions` (pins profile version), `session_knowledge` (pins snapshots), `transcript_segments` (final only), `questions`, `answers` (tokens, time to first token, model), `latency_events` |
| Settings | `provider_configs` (key *reference* and last 4 characters only; cached model list), `app_settings` (one row per section) |

IDs are UUIDv7. Deleting a profile or knowledge base removes everything under it, and `secure_delete` overwrites the freed pages. Sessions (Phase 3) will keep a snapshot of the context they used. "Delete my data" removes everything. The schema version is `PRAGMA user_version`. An existing database is backed up (still encrypted) before migrating, and a database from a newer app version is refused.

The database key is 256 random bits created on first run and kept in main's secret store (`secrets.json`, each entry encrypted with `safeStorage`). If it can't be read (for example, the data was copied to another Windows account), the app offers to start fresh instead of failing silently.

## 8. Security and privacy

- **API keys:** stored only through the OS keychain and used only in the engine process. Never in the database, logs or renderers.
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
packages/prompts/    versioned prompts, model output schemas, brief and knowledge compilers
docs/                architecture, ADRs, phase reports, release process
spikes/              Phase 0 benchmarks and the native audio module (kept as reference)
```

Still to come:
- `packages/native-audio/`: moves from `spikes/native-audio` in Phase 3.
- `evals/`: Phase 4.

## 10. Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Speed spikes, provider choices, native audio module, end-to-end prototype | **Done** (real-device Windows capture test moves to Phase 3) |
| 1 | Electron app foundation, monorepo, encrypted database, keychain, settings, CI with Windows builds | **Done** ([summary](phase1/summary.md)); signing waits for a certificate |
| 2 | Resume import and extraction, Application Knowledge, answer bank | **Done** ([summary](phase2/summary.md)) |
| 3 | Audio capture on real devices, live transcription, copilot window, hotkeys | Next |
| 4 | Turn detection + answer generation (**Windows MVP**) | |
| 5 | Speed and quality hardening: fact check, echo cancellation, provider failover | |
| 6 | Windows commercial release: onboarding, updates, licensing, privacy | |
| 7 | macOS | |
| 8 | Practice mode, offline mode, analytics | |
