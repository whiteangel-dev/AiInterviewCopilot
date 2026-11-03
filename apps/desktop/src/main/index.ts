import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, safeStorage, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { createLogger, type Logger } from '@aic/core';
import engineModulePath from '../engine/index?modulePath';
import { AppError, PROVIDERS, apiKeySecretRef, type SecureStorageLevel } from '@aic/ipc';
import { APP_ORIGIN, handleAppProtocol, registerAppSchemePrivileges } from './app-protocol';
import { loadOrCreateDbKey } from './data-key';
import { EngineHost } from './engine-host';
import { createInvokeHandlers } from './handlers';
import { broadcast, registerInvokeHandlers } from './ipc';
import { createMainWindow } from './main-window';
import { appPaths } from './paths';
import { SecretStore, type Cipher } from './secret-store';
import { hardenWebContents, isTrustedUrl, trustedOrigins } from './security';
import { runSmokeTest } from './smoke-test';
import { applyTheme, cacheTheme, readCachedTheme } from './theme';

// ── Before ready ────────────────────────────────────────────────────────────
// Development and test overrides; ignored in packaged builds.
if (!app.isPackaged) {
  if (process.env.AIC_USER_DATA_DIR)
    app.setPath('userData', resolve(process.env.AIC_USER_DATA_DIR));
  if (process.env.AIC_PASSWORD_STORE) {
    app.commandLine.appendSwitch('password-store', process.env.AIC_PASSWORD_STORE);
  }
}
app.setAppLogsPath(join(app.getPath('userData'), 'logs'));
if (process.platform === 'win32') app.setAppUserModelId('com.whiteangel.aiinterviewcopilot');
registerAppSchemePrivileges();

let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app
    .whenReady()
    .then(main)
    .catch((err: unknown) => {
      console.error('Failed to start', err);
      app.exit(1);
    });
}

function electronCipher(): Cipher {
  return {
    async level(): Promise<SecureStorageLevel> {
      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend();
        if (backend === 'basic_text' || backend === 'unknown') {
          // Linux without a keyring (CI, dev containers; Linux is not a release
          // platform). Reported as "weak" so the UI can say so.
          safeStorage.setUsePlainTextEncryption(true);
          return (await safeStorage.isAsyncEncryptionAvailable()) ? 'weak' : 'unavailable';
        }
      }
      return (await safeStorage.isAsyncEncryptionAvailable()) ? 'os' : 'unavailable';
    },
    encrypt: (plain) => safeStorage.encryptStringAsync(plain),
    async decrypt(data) {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(data);
      return { value: result, shouldReEncrypt };
    },
  };
}

async function main(): Promise<void> {
  const paths = appPaths();
  const log: Logger = createLogger({
    file: join(paths.logs, 'main.log'),
    console: !app.isPackaged,
    scope: 'main',
  });
  log.info('starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  });
  process.on('uncaughtException', (err) => log.error('uncaught exception', { err }));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { err: reason }));

  const secrets = new SecretStore(paths.secrets, electronCipher());
  await secrets.init();
  log.info('secure storage', { protection: secrets.level });
  applyTheme(readCachedTheme(paths.uiCache));

  const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  const origins = trustedOrigins(devServerUrl, APP_ORIGIN);
  hardenWebContents(origins, log.child('security'));
  handleAppProtocol(join(__dirname, '../renderer'));

  const host = new EngineHost({
    modulePath: engineModulePath,
    env: app.isPackaged ? {} : { AIC_ENGINE_CONSOLE: '1' },
    logger: log.child('engine-host'),
    initParams: async () => ({
      dbPath: paths.db,
      dbKeyHex: await loadOrCreateDbKey(secrets, existsSync(paths.db)),
      backupDir: paths.backups,
      logDir: paths.logs,
      appVersion: app.getVersion(),
      fakeProvider: !app.isPackaged && process.env.AIC_FAKE_PROVIDER === '1',
    }),
    onInitialized: async (client) => {
      for (const provider of PROVIDERS) {
        let key: string | null;
        try {
          key = await secrets.get(apiKeySecretRef(provider));
        } catch (err) {
          log.warn('saved API key could not be read', { provider, code: AppError.from(err).code });
          continue;
        }
        if (key)
          await client.call('apiKey.activate', { provider, key, verification: null, models: null });
      }
    },
  });

  host.events.on('status', (status) => broadcast('engine:status', status));
  host.events.on('apiKey.changed', (status) => broadcast('apiKey:changed', status));
  host.events.on('settings.changed', (settings) => {
    applyTheme(settings.appearance.theme);
    cacheTheme(paths.uiCache, settings.appearance.theme);
    broadcast('settings:changed', settings);
  });

  const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame;
    return !!frame && frame === event.sender.mainFrame && isTrustedUrl(frame.url, origins);
  };
  registerInvokeHandlers(
    createInvokeHandlers({ host, secrets, paths, log: log.child('ipc') }),
    isTrustedSender,
    log.child('ipc'),
  );

  host.start();
  // Apply the stored theme once the engine is up (the cache covers first paint).
  void host
    .call('settings.get')
    .then((settings) => {
      applyTheme(settings.appearance.theme);
      cacheTheme(paths.uiCache, settings.appearance.theme);
    })
    .catch(() => undefined);

  mainWindow = createMainWindow({
    url: devServerUrl ?? `${APP_ORIGIN}/index.html`,
    preload: join(__dirname, '../preload/index.js'),
    statePath: paths.windowState,
  });
  mainWindow.on('closed', () => (mainWindow = null));

  if (process.env.AIC_SMOKE_TEST === '1') {
    void runSmokeTest({ window: mainWindow, host, secrets, log: log.child('smoke') });
  }

  app.on('window-all-closed', () => app.quit());

  let shutdownComplete = false;
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void host.stop().finally(() => {
      shutdownComplete = true;
      log.info('stopped');
      log.close();
      app.quit();
    });
  });
}
