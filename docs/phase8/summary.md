# Phase 8 — The phone as a second screen (completed 2026-11-04)

**What changed:** answers can be followed on a phone (iPhone or Android) during an interview, in the phone's web browser, with nothing to install. The computer still does all the listening and answering, so Windows answer speed is unchanged.

Decisions: [ADR 0015](../adr/0015-phone-screen.md).

## How to use it

1. On the computer, go to **Settings → Phone screen** and turn it **On**. A QR code appears. During an interview, the **Phone** button on the Interview page shows the same code.
2. Connect the phone to the **same Wi-Fi** as the computer.
3. Scan the code with the phone's camera and open the link.
4. The phone shows the live answer, its fact-check marks and the transcript. Its buttons (Answer now, Shorter, Longer, Regenerate) work the computer's copilot.

Also:
- **Windows firewall:** if Windows asks whether to allow AI Interview Copilot on networks, choose **private networks**.
- **Screen:** keep the phone's screen on. On iPhone, set Auto-Lock to Never for the interview.
- **To disconnect every phone:** **Settings → Phone screen → Unpair all phones**.

## What was built

| Area | What |
|---|---|
| Phone page (`src/renderer/phone.html`) | The copilot's answer card and transcript in a phone layout. It reconnects by itself and follows the system's light or dark theme |
| Local server (`src/main/phone-server.ts`) | Runs only while the setting is on. It serves the phone page, a live feed (server-sent events) and two commands, and needs the pairing token for everything |
| Pairing | A random token in the QR code, then an HttpOnly cookie, kept across restarts in the OS-protected store. "Unpair all phones" makes a new one |
| Desktop UI | Settings → **Phone screen** card (on/off, QR code, phones connected, Copy link, Unpair) and a **Phone** button in the live interview |

## Verification

| Check | Result |
|---|---|
| Unit tests | **214 pass**. New phone-server tests:<ul><li>token and cookie;</li><li>nothing else is served (including a path-escape attempt);</li><li>the feed reaches every phone;</li><li>unpairing disconnects;</li><li>command protection;</li><li>error messages.</li></ul> |
| End-to-end | **21 of 21 pass**. New: a phone-sized window scans in, follows a whole interview, uses Shorter from the phone, and is locked out after unpairing |

## Known limitations

- **Same network only:** both devices must be on the same network, and it must let devices see each other. Some office, hotel and public Wi-Fi block that; a phone hotspot works.
- **Not encrypted on the network:** the page uses plain HTTP, because browsers allow nothing else for a local address without warnings. Use a private network.
- **Not yet on a real phone:** tested in a phone-sized browser window on this machine, not on a real iPhone or Android phone.
