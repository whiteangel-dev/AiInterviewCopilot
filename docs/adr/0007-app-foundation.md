# ADR 0007 — App foundation: process wiring, encrypted storage, secrets, packaging

- **Status:** Accepted (2026-11-03)

## Context
Phase 1 turns the approved architecture into a running app. These are the choices made while building it that later phases rely on.

## Decision

### Repository
- **npm workspaces.** `apps/desktop` plus internal packages `@aic/ipc`, `@aic/core` and `@aic/db`.
- **Packages export TypeScript source** and are bundled into the app. There is no separate package build step.
- **Only the native SQLite module ships as a runtime dependency.** Everything else is bundled.

### Processes
- **Main ↔ engine:** a typed RPC (`@aic/ipc/rpc`) over `process.parentPort`.
  - Requests have timeouts.
  - Errors travel with their codes.
  - The engine emits events back to main.
- **The engine is built as a separate bundle** (electron-vite `?modulePath`) that shares no chunks with main.
- **Restarts:** main restarts a crashed engine with backoff (0.25–10 s) and gives up after 5 crashes in a minute.
- **Fatal errors stop instead of looping:** a database that can't be unlocked or is newer than the app, or missing secure storage.

### Renderer ↔ main
- **One `invoke` bridge** exposes an allowlist of channels; the preload is sandboxed.
- **Every call is checked:**
  - the sender must be the main frame of a trusted origin;
  - the payload is validated with Zod in main;
  - the reply is a `Result` envelope, so error codes reach the UI.

### UI loading
- **Packaged builds load from `app://renderer/`** (a privileged custom scheme), not `file://`.
- **Each response carries a strict CSP** (`script-src 'self'`) and `nosniff`.
- **Paths can't escape** the renderer folder.

### Database
- **SQLite3MultipleCiphers** (`better-sqlite3-multiple-ciphers`) with ChaCha20-Poly1305.
- **A random 256-bit key** is generated on first run.
- **Node-API prebuilds** load in both Node (tests) and Electron, with no rebuild step.
- **drizzle-orm** for typed queries. drizzle-kit generates SQL migrations, which are embedded in the bundle.
- **Migrations:**
  - each runs in its own transaction;
  - the version is kept in `PRAGMA user_version`;
  - an encrypted file copy is made before migrating an existing database (the newest 3 are kept);
  - a database written by a newer app version is refused.

### Secrets
- **Main keeps a small secret store** (`secrets.json`): the database key and API keys, each encrypted with Electron `safeStorage` (DPAPI on Windows).
- **It uses the async safeStorage API** and re-encrypts entries when the OS key rotates.
- **The engine receives keys in memory.** The database stores only a key reference and the last 4 characters.
- **Logs redact** key patterns and every active secret value.

### Settings
- **Stored per section** (`app_settings`).
- **Read leniently:** an invalid or retired value falls back to its default, field by field.
- **Changed only through validated patches.**
- **The theme is applied through `nativeTheme.themeSource`.** The renderer follows `prefers-color-scheme`, and the theme is cached outside the database so the first frame is correct.

### Packaging
- **electron-builder:** a per-user NSIS installer for Windows x64.
- **Electron is pinned to an exact version.**
- **Fuses:**
  - `RunAsNode`, `NODE_OPTIONS` and inspect arguments are off;
  - asar integrity is on;
  - the app loads only from asar.
- **Only the target platform's SQLite binary ships.**

### Smoke test
- **`AIC_SMOKE_TEST=1`** checks the engine, database and UI, writes a JSON report and exits.
- CI runs it against the packaged and the installed Windows app, where Playwright can't attach because of the Fuses.

## Consequences
- **Engine stays isolated.** Engine code can't leak into main (separate bundle), and main never touches SQLite.
- **One native binary everywhere.** Adding tables is `npm run db:generate`, and CI fails if the schema and migrations drift apart.
- **Signing is pending.** Installers are unsigned until a code-signing certificate exists (see [release.md](../release.md)), so Windows SmartScreen will warn on install.
- **Linux is development-only.** Without a keyring, secrets use Chromium's basic store, and the UI says so.
