import { writeFileSync } from 'node:fs';
import { app, type BrowserWindow } from 'electron';
import type { Logger } from '@aic/core';
import { AppError } from '@aic/ipc';
import type { EngineHost } from './engine-host';
import type { SecretStore } from './secret-store';

const TIMEOUT_MS = 60_000;

/**
 * `AIC_SMOKE_TEST=1`: start normally, check that the engine, database and UI all
 * work, write a JSON report (to `AIC_SMOKE_TEST_OUT` or stdout), and exit 0 or 1.
 * Used in CI against the packaged app, where Playwright can't attach.
 */
export async function runSmokeTest(ctx: {
  window: BrowserWindow;
  host: EngineHost;
  secrets: SecretStore;
  /** The auto-updater module loaded (it must ship inside the app). */
  updaterLoaded: boolean;
  log: Logger;
}): Promise<void> {
  const { window, host, secrets, log } = ctx;
  const startedAt = Date.now();
  let finished = false;

  const finish = async (report: Record<string, unknown>) => {
    if (finished) return;
    finished = true;
    const json = JSON.stringify({ ...report, elapsedMs: Date.now() - startedAt }, null, 2);
    const out = process.env.AIC_SMOKE_TEST_OUT;
    if (out) writeFileSync(out, json);
    else process.stdout.write(json + '\n');
    log.info('smoke test finished', { ok: report.ok });
    await host.stop().catch(() => undefined);
    app.exit(report.ok === true ? 0 : 1);
  };

  const timer = setTimeout(() => void finish({ ok: false, error: 'timeout' }), TIMEOUT_MS);
  try {
    const settings = await host.call('settings.get');
    const ping = await host.call('ping');
    // Loads the native audio module (unpacked from app.asar) and lists devices.
    const audio = await host.call('audio.environment', { refresh: false });

    let uiReady = false;
    while (!uiReady && Date.now() - startedAt < TIMEOUT_MS - 5000) {
      if (!window.webContents.isLoading()) {
        uiReady = (await window.webContents.executeJavaScript(
          `document.querySelector('[data-app-ready="true"]') !== null`,
        )) as boolean;
      }
      if (!uiReady) await new Promise((r) => setTimeout(r, 250));
    }

    clearTimeout(timer);
    await finish({
      ok: uiReady,
      version: app.getVersion(),
      packaged: app.isPackaged,
      engine: host.status.state,
      schemaVersion: host.status.schemaVersion,
      enginePid: ping.pid,
      secureStorage: secrets.level,
      theme: settings.appearance.theme,
      uiReady,
      nativeAudio: audio.native.available,
      nativeAudioError: audio.native.error,
      nativeSources: audio.native.sources,
      audioBackend: audio.backend,
      audioDevices: audio.devices.length,
      updaterLoaded: ctx.updaterLoaded,
    });
  } catch (err) {
    clearTimeout(timer);
    await finish({ ok: false, error: AppError.from(err).toJSON() });
  }
}
