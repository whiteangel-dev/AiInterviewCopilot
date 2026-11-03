# Building and releasing

## Local builds

```
npm install
npm run build                    # electron-vite → apps/desktop/out
npm run dist:win                 # Windows installer → apps/desktop/dist (run on Windows)
npm run dist:dir -w @aic/desktop # unpacked app for the current OS (quick check)
```

The installer is a per-user NSIS installer (`AI-Interview-Copilot-Setup-<version>-x64.exe`). It doesn't need admin rights.

## CI

Every push to `main` builds the installer on `windows-latest`, then:
- runs the unit and end-to-end tests with real Windows DPAPI;
- smoke-tests the unpacked app;
- installs the app silently and smoke-tests the installed copy.

The installer is uploaded as the `windows-installer` artifact of the run.

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

Auto-update (electron-updater with GitHub Releases) is planned for Phase 6. `publish` is already set to this repository.

## Development-only switches

These are ignored in packaged builds:

| Variable | Effect |
|---|---|
| `AIC_USER_DATA_DIR` | Use another data folder (tests) |
| `AIC_FAKE_PROVIDER=1` | Offline fake Gemini: keys containing `INVALID` are rejected, `OFFLINE` fails like a network error |
| `AIC_PASSWORD_STORE=basic` | Linux: skip the OS keyring |
| `AIC_LIVE_TESTS=1` | Run the live Gemini tests, using the key in `.env.local` |
