import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  app,
  globalShortcut,
  safeStorage,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';
import { createLogger, type Logger } from '@aic/core';
import engineModulePath from '../engine/index?modulePath';
import {
  AppError,
  PROVIDERS,
  apiKeySecretRef,
  type EngineInitParams,
  type SecureStorageLevel,
  type Settings,
} from '@aic/ipc';
import { APP_ORIGIN, handleAppProtocol, registerAppSchemePrivileges } from './app-protocol';
import { BuiltInCapture } from './capture-window';
import { CopilotWindow } from './copilot-window';
import { loadOrCreateDbKey } from './data-key';
import { EngineHost } from './engine-host';
import { createInvokeHandlers } from './handlers';
import { Hotkeys } from './hotkeys';
import { broadcast, registerInvokeHandlers } from './ipc';
import { createMainWindow } from './main-window';
import { appPaths } from './paths';
import { SecretStore, type Cipher } from './secret-store';
import { hardenWebContents, isTrustedUrl, trustedOrigins } from './security';
import { runSmokeTest } from './smoke-test';
import { applyTheme, cacheTheme, readCachedTheme } from './theme';
import type * as ElectronUpdater from 'electron-updater';
import { Updates, type UpdaterLike } from './updater';

// ── Before ready ────────────────────────────────────────────────────────────
// Development and test overrides; ignored in packaged builds.
if (!app.isPackaged) {
  if (process.env.AIC_USER_DATA_DIR)
    app.setPath('userData', resolve(process.env.AIC_USER_DATA_DIR));
  if (process.env.AIC_PASSWORD_STORE) {
    app.commandLine.appendSwitch('password-store', process.env.AIC_PASSWORD_STORE);
  }
  // Tests: a fake microphone (a beep) for Electron's built-in capture.
  if (process.env.AIC_FAKE_MEDIA === '1') {
    app.commandLine.appendSwitch('use-fake-device-for-media-stream');
    app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
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

/** The native audio module for this platform, if the build includes one. */
function nativeAudioPath(): string | null {
  // Native modules can't load from inside app.asar; electron-builder unpacks them.
  const root = app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath();
  const file = join(
    root,
    'resources',
    'native',
    `${process.platform}-${process.arch}`,
    'aic_native_audio.node',
  );
  if (!app.isPackaged && process.env.AIC_NATIVE_AUDIO === '0') return null;
  return existsSync(file) ? file : null;
}

/** Development and tests: recorded WAVs instead of live capture. */
function audioReplay(): EngineInitParams['audioReplay'] {
  if (app.isPackaged) return null;
  const interviewer = process.env.AIC_AUDIO_REPLAY_INTERVIEWER;
  const candidate = process.env.AIC_AUDIO_REPLAY_CANDIDATE;
  if (!interviewer && !candidate) return null;
  return {
    interviewer: interviewer ? resolve(interviewer) : null,
    candidate: candidate ? resolve(candidate) : null,
  };
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
      nativeAudioPath: nativeAudioPath(),
      audioReplay: audioReplay(),
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

  const rendererUrl = (page: string) =>
    devServerUrl ? `${devServerUrl.replace(/\/$/, '')}/${page}` : `${APP_ORIGIN}/${page}`;
  const preloadPath = join(__dirname, '../preload/index.js');

  const copilot = new CopilotWindow({
    url: rendererUrl('copilot.html'),
    preload: preloadPath,
    statePath: paths.copilotWindowState,
    onVisibilityChange: (visible) => broadcast('copilot:visibility', visible),
  });
  const capture = new BuiltInCapture({
    url: rendererUrl('capture.html'),
    preload: join(__dirname, '../preload/capture.js'),
    rendererRoot: join(__dirname, '../renderer'),
    host,
    log: log.child('capture'),
  });
  const hotkeys = new Hotkeys(
    globalShortcut,
    {
      toggleCopilot: () => copilot.toggle(),
      pauseListening: () => {
        void host
          .call('live.state')
          .then((state) => {
            if (state?.status === 'live') return host.call('live.pause');
            if (state?.status === 'paused') return host.call('live.resume');
            return null;
          })
          .catch((err: unknown) => log.warn('pause hotkey failed', { err }));
      },
      answerNow: () => {
        if (!copilot.visible) copilot.show();
        void host
          .call('live.answerNow')
          .catch((err: unknown) => log.info('answer-now hotkey did nothing', { err }));
      },
      regenerate: () => {
        void host
          .call('live.regenerate', { answerId: null, length: null })
          .catch((err: unknown) => log.info('regenerate hotkey did nothing', { err }));
      },
    },
    log.child('hotkeys'),
  );

  let currentSettings: Settings | null = null;
  const applySettings = (settings: Settings) => {
    currentSettings = settings;
    applyTheme(settings.appearance.theme);
    cacheTheme(paths.uiCache, settings.appearance.theme);
    copilot.apply(settings.copilot);
    if (hotkeys.apply(settings.hotkeys)) broadcast('hotkeys:status', hotkeys.statuses);
  };

  host.events.on('status', (status) => {
    broadcast('engine:status', status);
    if (status.state !== 'ready') {
      // A restarted engine has no live run.
      capture.close();
      broadcast('live:state', null);
    }
  });
  host.events.on('apiKey.changed', (status) => broadcast('apiKey:changed', status));
  host.events.on('job.progress', (progress) => broadcast('job:progress', progress));
  host.events.on('settings.changed', (settings) => {
    applySettings(settings);
    broadcast('settings:changed', settings);
  });
  let shownFor: string | null = null;
  let liveRunning = false;
  host.events.on('live.state', (state) => {
    broadcast('live:state', state);
    liveRunning =
      !!state &&
      (state.status === 'starting' || state.status === 'live' || state.status === 'paused');
    if (state?.mode === 'interview' && state.status === 'live' && shownFor !== state.id) {
      shownFor = state.id;
      if (currentSettings?.copilot.showOnStart ?? true) copilot.show();
    }
  });
  host.events.on('live.meter', (meter) => broadcast('live:meter', meter));
  host.events.on('live.transcript', (update) => broadcast('live:transcript', update));
  host.events.on('live.answer', (answer) => broadcast('live:answer', answer));
  host.events.on('live.turn', (update) => broadcast('live:turn', update));
  host.events.on('capture.open', (request) => capture.open(request));
  host.events.on('capture.close', ({ runId }) => capture.close(runId));

  // Automatic updates: installed Windows builds only (not development, tests or smoke tests).
  const smokeTest = process.env.AIC_SMOKE_TEST === '1';
  const updatesWanted =
    app.isPackaged && process.platform === 'win32' && process.env.AIC_DISABLE_UPDATES !== '1';
  let updater: UpdaterLike | null = null;
  let updaterLoaded = false;
  if (app.isPackaged) {
    try {
      // Loaded lazily; the smoke test checks it ships with the app.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('electron-updater') as typeof ElectronUpdater;
      updaterLoaded = true;
      if (updatesWanted && !smokeTest) updater = mod.autoUpdater;
    } catch (err) {
      log.error('the updater could not be loaded', { err });
    }
  }
  const updates = new Updates({
    updater,
    disabledReason: !app.isPackaged
      ? 'Updates are off in development builds.'
      : process.platform !== 'win32'
        ? 'Automatic updates are available on Windows.'
        : 'Updates are off.',
    busy: () => liveRunning,
    onStatus: (status) => broadcast('app:update', status),
    log: log.child('updates'),
  });
  updates.start();

  const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame;
    return !!frame && frame === event.sender.mainFrame && isTrustedUrl(frame.url, origins);
  };
  registerInvokeHandlers(
    createInvokeHandlers({
      host,
      secrets,
      paths,
      log: log.child('ipc'),
      copilot,
      hotkeys,
      updates,
      mainWindow: () => mainWindow,
    }),
    isTrustedSender,
    log.child('ipc'),
  );

  host.start();
  // Apply the stored theme once the engine is up (the cache covers first paint).
  void host
    .call('settings.get')
    .then(applySettings)
    .catch(() => undefined);

  mainWindow = createMainWindow({
    url: rendererUrl('index.html'),
    preload: preloadPath,
    statePath: paths.windowState,
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    // The copilot window only hides on close; quit with the main window.
    copilot.destroy();
    capture.close();
  });

  if (process.env.AIC_SMOKE_TEST === '1') {
    void runSmokeTest({
      window: mainWindow,
      host,
      secrets,
      updaterLoaded,
      log: log.child('smoke'),
    });
  }

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => hotkeys.unregisterAll());

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
