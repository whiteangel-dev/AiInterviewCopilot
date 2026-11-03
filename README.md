# AI Interview Copilot

A desktop app (Windows first, macOS later) that listens to a live job interview and streams short, natural answers grounded in your resume and your own notes.

**Status:** Phase 0 (technical validation) is complete. The end-to-end prototype goes from the interviewer's last word to the first answer word in **~1.0 s median**. Next: Phase 1, the app foundation.

## Docs

- [Architecture](docs/architecture.md)
- [Decision records](docs/adr/)
- [Phase 0 results](docs/phase0/results.md)

## Repository

| Path | What |
|---|---|
| `spikes/` | Phase 0 benchmarks (TypeScript, Gemini): transcription, answer latency, turn analyzer, end-to-end prototype |
| `spikes/native-audio/` | Rust (napi-rs) WASAPI capture module (Option B) |
| `spikes/capture-win/` | Electron built-in capture test app (Option A) |
| `docs/` | Architecture, ADRs, phase reports |

## Running the Phase 0 benchmarks

Requires Node.js 22.18+ (runs TypeScript directly) and a Gemini API key.

```
cp .env.example .env.local      # then set GEMINI_API_KEY in .env.local (git-ignored)
cd spikes && npm install
npm run e2e                     # after `npm run gen-audio`
```

See [docs/phase0/results.md](docs/phase0/results.md) for every benchmark command. **Never put real keys in `.env.example` or any tracked file.**
