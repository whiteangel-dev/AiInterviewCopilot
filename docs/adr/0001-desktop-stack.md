# ADR 0001 — Desktop stack: Electron + TypeScript, Rust for audio

- **Status:** Accepted (2026-11-03)

## Context
- The product is a commercial desktop app: Windows first, macOS later.
- It needs real-time audio capture, streaming network clients, a polished UI, and auto-update.
- The team prefers TypeScript. A Tauri/Rust stack was proposed and rejected in favor of Electron.

## Decision
- Use **Electron + React + TypeScript + Vite + Tailwind**, with SQLite for storage.
- The live pipeline runs in an Electron `utilityProcess`, not in the main process or a renderer.
- Platform audio capture is a small **Rust native module built with napi-rs**. It uses N-API, so it doesn't need rebuilding for each Electron upgrade.

## Consequences
- **Pros:**
  - one language for nearly all code;
  - official SDKs for Gemini, OpenAI and Claude;
  - Chromium renders identically on both operating systems;
  - mature packaging and auto-update.
- **Costs:**
  - a larger installer and more memory than Tauri;
  - process separation needs discipline;
  - a small native codebase that must be built per OS in CI.
