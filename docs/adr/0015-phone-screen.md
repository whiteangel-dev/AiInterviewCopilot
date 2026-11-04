# ADR 0015 — The phone as a second screen

- **Status:** Accepted (2026-11-04). Built in Phase 8 (version 1.3.0).

## Context
The owner wants the app on iPhone and Android too. A phone can't hear another app's call audio: iOS forbids it, and Android excludes voice-call audio from capture. So the first mobile step is the phone as a **second screen** for the computer running the interview.
- **Why it helps:** the answers are on a separate device, off the shared or recorded screen, and easy to glance at.
- **Constraint:** Windows answer speed must not suffer.

## Decision
- **A web page, not an app.** The phone opens the page in Safari or Chrome. Nothing to install, no store, and both platforms are served by one page (`src/renderer/phone.html`). It reuses the copilot's answer card and transcript, so it behaves the same: fact-check marks, earlier answers, Answer now, Shorter, Longer, Regenerate.
- **Served by the Windows app on the local network,** only while Settings → Phone screen is on (off by default).
  - **Where:** a small Node HTTP server in main (`src/main/phone-server.ts`), on the first free port from 47600, on every local IPv4 address.
  - **What it serves:** only the phone page, its assets, a live feed and two commands. Nothing else in the app (profiles, notes, keys) is reachable.
- **Pairing:**
  - **The token:** the QR code is a link with a random 192-bit token. The first visit swaps it for an HttpOnly, SameSite=Strict cookie, and the page removes it from the address bar.
  - **Checks:** every request needs the token, compared in constant time.
  - **Storage:** the token is kept in the OS-protected secret store, so phones stay paired across restarts.
  - **Unpairing:** "Unpair all phones" makes a new token and disconnects them.
- **Live feed: server-sent events** (`/api/events`), not WebSockets.
  - Built into every phone browser and into Node, with no dependency.
  - Reconnects by itself; each connection starts with a snapshot (state, transcript, answers).
  - A heartbeat every 15 s.
  - Main forwards the same events it already sends to the windows (state, transcript, answers, turn phase), but not the 10-per-second meter. **No work is added to the engine or the answer path.**
- **Commands:** `POST /api/command` (Answer now, Regenerate with a length). They need a custom header, which another site can't send without a preflight that's never answered, so cross-site requests fail.
- **Security headers:** a strict CSP, `nosniff`, `no-referrer`.
- **Plain HTTP.** Browsers allow nothing else for a local address without certificate warnings, and the Web Crypto API is unavailable on plain HTTP, so the page can't decrypt anything itself.
  - The UI says to use a private network, not public Wi-Fi.
  - Windows may ask to allow the app on networks: allow on private networks.
- **The QR code** is drawn in the renderer (`qrcode`, bundled), from the first local address.

## Evidence
- **Unit tests (4):** token and cookie handling; only the phone page and its assets are served (with a path-escape check); the feed reaches every phone; unpairing disconnects; commands need their header; failure messages.
- **End-to-end test:** a phone-sized browser window opens the link.
  - It shows "Connected", and the computer counts 1 phone.
  - It follows a whole interview: the answer streams, with the fact-check mark and the transcript.
  - "Shorter" on the phone makes a new answer on both screens.
  - After "Unpair all phones", reloading shows "Scan the QR code".

## Consequences
- **Same network only:** the phone and computer must share a local network that lets devices reach each other. Some office and hotel Wi-Fi block that ("client isolation"); a phone hotspot works.
- **Keep the screen on:** browsers only allow an app to keep the screen on over HTTPS, so on iPhone set Auto-Lock to Never during the interview.
- **Still to build:** phone-only listening (the phone's own microphone, without a computer) needs a native app (Phase 10).
