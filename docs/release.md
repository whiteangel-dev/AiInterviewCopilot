# Building and releasing

## Local builds

```
npm install
npm run build -w @aic/native-audio  # native audio module (Rust) → apps/desktop/resources/native/
npm run build                    # electron-vite → apps/desktop/out
npm run dist:win                 # Windows installer → apps/desktop/dist (run on Windows)
npm run dist:dir -w @aic/desktop # unpacked app for the current OS (quick check)
```

A Windows release must include the native audio module. Building it needs Rust (stable, MSVC); it links the C runtime statically, so users need no Visual C++ redistributable. An installer built without it still works, with Electron's built-in capture only.

The installer is a per-user NSIS installer (`AI-Interview-Copilot-Setup-<version>-x64.exe`). It doesn't need admin rights.

## CI

Every push to `main` builds the native audio module and the installer on `windows-latest`, then:
- runs the unit and end-to-end tests with real Windows DPAPI;
- smoke-tests the unpacked app;
- installs the app silently and smoke-tests the installed copy. The smoke test fails if the native audio module doesn't load.

The installer is uploaded as the `windows-installer` artifact of the run (for testing; users download releases instead, see below).

## Smoke test

```
set AIC_SMOKE_TEST=1
set AIC_SMOKE_TEST_OUT=report.json
"AI Interview Copilot.exe"
```

The app starts normally, then:
1. checks that the engine, the encrypted database and the UI all work;
2. writes a JSON report to `AIC_SMOKE_TEST_OUT`;
3. exits with code 0 (pass) or 1 (fail).

## Code signing (not yet configured)

Unsigned installers trigger a Windows SmartScreen warning. Signing needs one of these:

1. **Azure Trusted Signing (recommended).** It's the cheapest option, has no hardware token, and reputation builds quickly.
   - Create a Trusted Signing account and certificate profile.
   - Add `win.azureSignOptions` to `apps/desktop/electron-builder.yml`: `publisherName`, `endpoint`, `certificateProfileName`, `codeSigningAccountName`.
   - Add the repository secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`.
   - Pass those secrets as `env` to the Windows job.
2. **An OV/EV certificate as a .pfx file.**
   - Add the repository secrets `WIN_CSC_LINK` (base64 .pfx) and `WIN_CSC_KEY_PASSWORD`.
   - The CI job already passes them to electron-builder as `CSC_LINK` / `CSC_KEY_PASSWORD`.
   - Signing happens automatically when they're set.

## Releasing a version

1. Set the new version in `apps/desktop/package.json` (and the root `package.json`), then commit it to `main`.
2. Tag the commit and push the tag:
   ```
   git tag v1.0.1
   git push origin v1.0.1
   ```
3. The `release` workflow (`.github/workflows/release.yml`) then:
   - checks that the tag matches the version;
   - runs the unit tests;
   - builds the native audio module and the installer;
   - uploads the installer, its `.blockmap` and `latest.yml` to a **draft** GitHub Release;
   - installs the app and smoke-tests it.
4. When the workflow has passed, open the draft on GitHub, add release notes, and click **Publish release**:
   - the download link in the README (`/releases/latest`) points to it;
   - installed apps find it within about four hours, or at their next start.

Don't publish a draft whose workflow failed.

## Automatic updates

Installed Windows builds use `electron-updater` with GitHub Releases (`publish` in `electron-builder.yml`).

- **Checking:** 15 s after start, then every 4 hours.
- **Downloading:** in the background.
- **Installing:** "Restart to update" appears in the sidebar and in Settings → About. Otherwise the update installs the next time the app quits. The app never restarts itself, and refuses to while an interview runs.
- **Turned off:** in development builds, smoke tests, and with `AIC_DISABLE_UPDATES=1`.
- **Signing:** unsigned builds update without signature checks. Once signing is set up, electron-updater also checks that an update is signed by the same publisher.

## Development-only switches

These are ignored in packaged builds:

| Variable | Effect |
|---|---|
| `AIC_USER_DATA_DIR` | Use another data folder (tests) |
| `AIC_FAKE_PROVIDER=1` | Offline fake Gemini: keys containing `INVALID` are rejected, `OFFLINE` fails like a network error |
| `AIC_PASSWORD_STORE=basic` | Linux: skip the OS keyring |
| `AIC_LIVE_TESTS=1` | Run the live Gemini tests, using the key in `.env.local` |
| `AIC_DISABLE_UPDATES=1` | No automatic update checks (also honored by packaged builds) |
| `AIC_PHONE_HOST=127.0.0.1` | The phone screen listens only on this address (tests) |
