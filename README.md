# AI Interview Copilot

A desktop app (Windows first, macOS later) that listens to a live job interview and streams short, natural answers grounded in your resume and your own notes.

## Status

| Phase | What | Status |
|---|---|---|
| 0 | Technical validation: last word → first answer word in **~1.0 s median** | Done ([results](docs/phase0/results.md)) |
| 1 | App foundation: Electron app, encrypted database, OS-protected keys, settings, Windows installer in CI | Done ([summary](docs/phase1/summary.md)) |
| 2 | Resume import, Application Knowledge, answer bank | Next |

## Docs

- [Architecture](docs/architecture.md)
- [Decision records](docs/adr/)
- [Building and releasing](docs/release.md)

## Repository

| Path | What |
|---|---|
| `apps/desktop/` | The Electron app: `src/main` (windows, secrets, IPC), `src/engine` (utility process: database, AI), `src/preload`, `src/renderer` (React UI), `e2e/` (Playwright) |
| `packages/ipc/` | Contracts between processes: IPC channels, settings schema, engine RPC, errors |
| `packages/core/` | Engine logic without Electron: Gemini provider, model roles, logging, secret redaction |
| `packages/db/` | Encrypted SQLite: schema, migrations, repositories |
| `spikes/` | Phase 0 benchmarks and the Rust (napi-rs) WASAPI capture module |
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

**Other commands:**
- `npm run db:generate`: after changing `packages/db/src/schema.ts`, writes a new SQL migration. Commit it.
- `npm run dist:win`: Windows installer. See [docs/release.md](docs/release.md).

**Gemini key:** you enter it in the app under **Settings → Gemini API key**, and the app keeps it encrypted by the OS. For the Phase 0 benchmarks and the opt-in live tests (`AIC_LIVE_TESTS=1 npm test`), put it in `.env.local`:

```
cp .env.example .env.local      # then set GEMINI_API_KEY (the file is git-ignored)
```

**Never put real keys in `.env.example` or any tracked file.**

If Electron starts as plain Node (for example, from a VS Code task), unset `ELECTRON_RUN_AS_NODE`.
