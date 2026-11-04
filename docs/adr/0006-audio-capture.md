# ADR 0006 — Audio capture: native WASAPI module first, Electron loopback as fallback

- **Status:** Accepted (2026-11-03). Built in Phase 3 ([ADR 0009](0009-live-listening.md)); real-device validation is the user's first test.

## Context
Electron's built-in capture (`getDisplayMedia` loopback) has these limits:
- it records only all system audio (notifications and our own sounds included);
- it runs inside a renderer window;
- it gives little control over device changes.

## Decision
- Primary: the **Rust napi-rs module** (`packages/native-audio`, moved from `spikes/native-audio` in Phase 3):
  - WASAPI shared, event-driven mode, for the microphone, system loopback and **per-app loopback**;
  - Windows converts to 16 kHz mono where possible, otherwise Rust converts;
  - silence gaps are filled to keep the timeline continuous;
  - 20 ms frames delivered through a thread-safe callback.
- Fallback: **Electron built-in capture** (`spikes/capture-win`).

## Evidence (Phase 0)
- Frame assembler unit tests pass.
- The Windows code type-checks and passes clippy for `x86_64-pc-windows-msvc`.
- The Rust → JS plumbing delivers frames exactly every 20 ms (Linux test-tone smoke test).
- CI built the module with MSVC on `windows-latest`, loaded it in Node, and passed the smoke test ([run 41584452723](https://github.com/whiteangel-dev/AiInterviewCopilot/actions/runs/41584452723)).
- **Not yet run against real Windows audio devices.**

## Consequences
- Phase 3 starts with a real-device test of both options, using the existing smoke test and capture app, and adds:
  - following default-device changes;
  - an app picker for per-app capture;
  - echo detection.
