# Phase 1 — App foundation (completed 2026-11-03)

**Result:** a working, hardened Electron app. It has an encrypted local database, OS-protected secrets, Gemini key setup with model discovery, settings, and CI that builds and smoke-tests the Windows installer. Decisions: [ADR 0007](../adr/0007-app-foundation.md). Release process: [release.md](../release.md).

## What was built

| Area | What |
|---|---|
| Monorepo | npm workspaces: `apps/desktop`, `packages/ipc`, `packages/core`, `packages/db` |
| Processes | Main (windows, secrets, IPC), engine `utilityProcess` (database, AI provider), sandboxed renderer |
| IPC | Allowlisted bridge, trusted-sender check, Zod validation, error codes end to end; typed main ↔ engine RPC with timeouts and events |
| Engine supervision | Restart with backoff after a crash; stops with a clear screen on unrecoverable errors |
| Database | SQLite3MultipleCiphers (ChaCha20-Poly1305); key generated on first run; drizzle schema + embedded migrations; encrypted backup before migrating; refuses newer schemas |
| Secrets | `safeStorage` (async API, DPAPI on Windows) for the database key and the Gemini key; keys never reach the renderer, database or logs |
| Gemini | Key check before saving (rejected vs. couldn't-check); model list cached for 24 h; recommendations prefer the Phase 0 measured models |
| UI | React 19 + Tailwind 4 + Radix: Home (setup checklist, how it works, privacy) and Settings (API key, models, answers, appearance, privacy and data, about); light/dark/system theme; custom title bar |
| Recovery | "Start fresh" screen when local data can't be unlocked; "Delete all local data" in Settings |
| Packaging | NSIS per-user installer (x64), Electron Fuses, `app://` protocol with a strict CSP, only the needed native binary |
| CI | Linux: lint, format, types, unit tests, schema-drift check, build, e2e (Xvfb). Windows: unit tests, e2e with real DPAPI, installer build, smoke tests of the unpacked and the installed app |

## Verification

| Check | Result |
|---|---|
| Unit tests (Vitest) | 55 pass; 2 live Gemini tests skipped by default |
| Live Gemini tests (`AIC_LIVE_TESTS=1`, real key) | Pass: valid key lists models including `gemini-3.5-flash-lite`; a fake key is rejected as invalid |
| End-to-end (Playwright, Linux) | 6 of 6 pass (~10 s); see the list below |
| Smoke test, built app (Linux) | launch → engine ready → UI ready in **235 ms** |
| Smoke test, packaged app with Fuses (Linux) | **242 ms**; native module loads from `app.asar.unpacked` |
| Smoke test, dev server (`npm run dev`) | 732 ms |
| Fuses (read back from the packaged binary) | RunAsNode, NODE_OPTIONS, inspect arguments: off. Asar integrity, only-load-from-asar, cookie encryption: on |
| Windows | Runs in CI: unit tests, e2e, installer build, unpacked and installed smoke tests |

**End-to-end tests:**
1. First run: engine ready, setup checklist, database file not plaintext.
2. API key:
   - a rejected key isn't saved;
   - a valid key is verified and its models listed;
   - it survives a restart;
   - the key string appears in **no file** under the data folder.
3. Settings: theme and answer mode persist across restarts, and the theme drives `prefers-color-scheme`.
4. Isolation:
   - the renderer has no `require` or `process`;
   - the bridge exposes only `invoke`, `on` and `platform`;
   - invalid payloads, extra fields, disallowed links and unknown channels are rejected.
5. A missing database key shows the recovery screen, and "Start fresh" recovers.
6. "Delete all local data" removes the key and resets settings.

**Bundle sizes:** main 203 KB, engine 1.8 MB (mostly the Gemini SDK, unminified), preload 1.6 KB, renderer 393 KB JS + 25 KB CSS. The packaged `app.asar` is 3.1 MB.

## Not done / carried over

- **Code signing:** needs a certificate (Azure Trusted Signing recommended). Builds are unsigned until then; see [release.md](../release.md).
- **Auto-update:** Phase 6, as planned. `publish` already points at this repository.
- **Engine cold start:** about 200 ms from spawn to database ready. Loading the Gemini SDK lazily could cut this before the Phase 3 restart-during-interview work.
- **Copilot window, tray and global hotkeys:** Phase 3, with the live pipeline.
- **Real-device Windows audio test:** still Phase 3, task 1.
