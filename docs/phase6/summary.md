# Phase 6 — Windows release (completed 2026-11-04)

**What changed:** anyone can download the app and use it.
- **Download:** a public installer link.
- **Updates:** they install themselves.
- **Free key:** works with no billing. Setup asks for it on the first screen.
- **No licensing, accounts or sign-up**, by choice.

Decisions: [ADR 0012](../adr/0012-distribution.md).

## What was built

| Area | What |
|---|---|
| Public downloads | `release` workflow: a version tag builds and tests the installer and uploads it to a **draft** GitHub Release. You publish it with one click. The README links to `/releases/latest` |
| Automatic updates | electron-updater with GitHub Releases:<ul><li>checks 15 s after start and every 4 hours;</li><li>downloads in the background;</li><li>"Restart to update" in the sidebar and Settings → About;</li><li>otherwise installs the next time the app quits;</li><li>never restarts during an interview.</li></ul> |
| Free keys | Live features run on Google's free tier. When a key can't use the Pro model, preparation switches to `gemini-3.8-flash` (free) and Quality answers to Fast, remembered until the key changes |
| First-run setup | The Home page's first step: "Get a free key" (opens Google AI Studio), three short steps, paste and Connect |
| README | Starts with Download and Get started for users; the developer notes come after |
| Version | 1.0.0 |

## Verification

| Check | Result |
|---|---|
| Unit tests | **201 pass** (Phase 5: 194). New:<ul><li>the updater: download, restart refused during an interview, plain error messages, off in development, timing;</li><li>free-tier errors recognized;</li><li>preparation falls back to a free model and remembers it;</li><li>live requests skip a model the key doesn't have.</li></ul> |
| End-to-end (Playwright, built app) | **19 of 19 pass**. New: connecting Gemini from the Home page (a rejected key, then a good one) |
| CI smoke test | Also fails now if the updater is missing from the installed app |
| CI ([run 41871981702](https://github.com/whiteangel-dev/AiInterviewCopilot/actions/runs/41871981702)) | All jobs pass, including Windows unit and e2e tests (19 of 19) and the installer |
| Release `v1.0.0` ([run 41872021895](https://github.com/whiteangel-dev/AiInterviewCopilot/actions/runs/41872021895)) | Passed: tests, installer built and uploaded to a **draft** release, installed app smoke-tested (native audio and updater loaded). Waiting for you to publish |

## Publishing a release

1. Wait for the `release` workflow for the tag to pass (GitHub → Actions).
2. Open GitHub → **Releases**, open the draft, write a few words about what's new, and click **Publish release**.
3. The README's download link now gives everyone this version. Installed apps update within a few hours.

For later versions: change the version in `apps/desktop/package.json`, commit, and push a matching tag (`git tag v1.0.1 && git push origin v1.0.1`). See [release.md](../release.md).

## Added in 1.1.0: key files

Share your Gemini key with someone without sending it in plain text ([ADR 0013](../adr/0013-key-files.md)):
- **You:** Settings → **Share your key** → **Create key file**. Enter the key to share, who it's for, a password and an optional end date, then send the file.
- **Them:** Home → **Someone gave you a key file? Import it**, choose the file and type the password (sent separately).
- **After import:** the key is stored protected by Windows and never shown. After the end date the app stops using it.
- **Tests:** 4 unit tests (encryption round trip, wrong password, a changed file, uniqueness, expiry in the engine) and an end-to-end test with two separate installs (one creates, the other imports).

The app must send the key to Google, so someone with technical skill could still recover it. Give each person their own key in Google AI Studio and delete it when they're done; that is the dependable way to end access.

## Known limitations

- **SmartScreen warning:** Windows warns about an unknown publisher until the app is code-signed, for example with Azure Trusted Signing (about $10 a month). Users click **More info → Run anyway**.
- **Free keys:**
  - Google's free tier has rate limits it doesn't publish per model. A rate limit sends live requests to the backup model.
  - Google may use free-tier content to improve its products (its pricing page says so). A key with billing on avoids that and uses the stronger Pro model for preparation.
- **Free-key preparation hasn't been tried with a real free key** (only through tests), because the development key has billing on.
- **Earlier checks still pending:** the real-device checks from Phases 3–5 (microphone, call audio, speakers) still need a Windows PC.
