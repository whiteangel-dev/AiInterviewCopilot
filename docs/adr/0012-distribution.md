# ADR 0012 — Distribution: public downloads, automatic updates, free keys, first-run setup

- **Status:** Accepted (2026-11-04). Built in Phase 6.

## Context
The goal for the first release is that anyone can download the app and use it: no license keys, no accounts, no sign-up. Licensing and privacy work were dropped from Phase 6 at the owner's request. The data protection already built (local, encrypted, no audio saved) stays as it is.

Until now, the installer was only a CI artifact: downloading it needed a GitHub login and unzipping. And every user needs a Gemini key, which costs money only if Google's free tier doesn't cover the models the app uses.

## Decision

### Public downloads: GitHub Releases
- **The pipeline:** a version tag (`v1.0.0`, matching `apps/desktop/package.json`) runs `.github/workflows/release.yml`.
  - It runs the unit tests, builds the native audio module and the installer, and smoke-tests the installed app.
  - It uploads the installer, its `.blockmap` and `latest.yml` to a **draft** release.
- **The owner publishes the draft.** Nothing becomes public, or reaches installed apps, until then.
- **The download link** in the README is `/releases/latest`, which never changes.
- **Not signed yet:** Windows SmartScreen warns ("More info → Run anyway"). Signing stays optional and is set up as before ([release.md](../release.md)); once it is, electron-updater also checks that updates come from the same publisher.

### Automatic updates: electron-updater
- **Which builds:** installed Windows builds only, not development builds or smoke tests (`AIC_DISABLE_UPDATES=1` turns them off).
- **Checking:** 15 s after start, then every 4 hours, against GitHub Releases.
- **Download:** in the background.
- **Install:**
  - The sidebar and Settings → About offer "Restart to update".
  - Otherwise the update installs the next time the app quits.
  - The app never restarts by itself, and refuses to while an interview or audio test runs.
- **Checked in CI:** the module must ship inside the app. The CI smoke test fails without it (it's loaded lazily, so a missing module wouldn't otherwise show up).

### Free keys work
From Google's pricing page (2026-11-04):
- **Free of charge on the free tier:** `gemini-3.5-transcribe-live`, `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite`, so live transcription, turn detection, answers, the backup and the fact check are all covered.
- **Not available on the free tier:** `gemini-3.1-pro-preview`, which the app uses for preparation and Quality answers.

So:
- **Recognizing "not on your key":** Google's "not on your free tier" reply (429 with a quota `limit: 0`) and "model not found" (404) are marked as *model unavailable*, unlike an ordinary rate limit.
- **Preparation** (resume, notes review, answer bank) then switches to `gemini-3.8-flash`, free and the strongest free model. Phase 2 found Flash 2.4× faster than Pro but slightly more inclined to embellish, and the quote check still runs.
- **Quality answers** go to the Fast model, then the backup.
- **Remembering:** unavailable models are remembered until the key changes, so later requests skip the failing call.

### First-run setup
The Home checklist's first step is now the key itself:
- **"Get a free key"** opens Google AI Studio;
- three short instructions;
- a field to paste the key, with **Connect**.

New users don't need to find Settings.

### Version
**1.0.0**, the first public release.

## Consequences
- **The owner presses Publish** on each draft release after its workflow passes; that is the only manual step.
- **SmartScreen warns** until the app is signed.
- **Google's free tier has rate limits** that Google doesn't state per model on the pricing page.
  - A rate limit on the answer model sends live requests to the backup, which has its own limits.
  - Free-tier content may be used by Google to improve its products, as its pricing page says. Users who mind can turn on billing.
- **Free-key preparation hasn't been tested yet:** it was measured on a paid key; the fallback path is covered by unit tests and needs a run with a real free key.
