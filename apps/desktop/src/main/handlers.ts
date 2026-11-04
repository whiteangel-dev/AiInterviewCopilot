import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, shell } from 'electron';
import type { Logger } from '@aic/core';
import {
  AppError,
  FORWARDED_CHANNELS,
  LONG_RUNNING_CHANNELS,
  PROVIDERS,
  apiKeySecretRef,
  type AppInfo,
  type ForwardedChannel,
  type KeyOrigin,
  type ProviderId,
} from '@aic/ipc';
import type { CopilotWindow } from './copilot-window';
import type { EngineHost } from './engine-host';
import type { Hotkeys } from './hotkeys';
import { KEY_FILE_EXTENSION, createKeyFile, expiryText, readKeyFile } from './key-file';
import { broadcast, type InvokeHandlers } from './ipc';
import type { AppPaths } from './paths';
import type { SecretStore } from './secret-store';
import type { PhoneScreen } from './phone';
import type { Updates } from './updater';

interface Context {
  host: EngineHost;
  secrets: SecretStore;
  paths: AppPaths;
  log: Logger;
  copilot: CopilotWindow;
  hotkeys: Hotkeys;
  updates: Updates;
  phone: PhoneScreen;
  /** Parent for dialogs. */
  mainWindow: () => BrowserWindow | null;
}

/** Network calls to the provider can be slow; allow more than the default RPC timeout. */
const PROVIDER_CALL = { timeoutMs: 30_000 };
/** AI jobs (resume analysis, answer bank) can take minutes. */
const AI_JOB_CALL = { timeoutMs: 6 * 60_000 };

/** Channels main passes straight to the engine (input already validated by zod). */
function forwardedHandlers(host: EngineHost): Pick<InvokeHandlers, ForwardedChannel> {
  const entries = (Object.keys(FORWARDED_CHANNELS) as ForwardedChannel[]).map((channel) => [
    channel,
    (input: unknown) =>
      host.forward(
        FORWARDED_CHANNELS[channel],
        input,
        LONG_RUNNING_CHANNELS.has(channel) ? AI_JOB_CALL : PROVIDER_CALL,
      ),
  ]);
  return Object.fromEntries(entries) as Pick<InvokeHandlers, ForwardedChannel>;
}

export function createInvokeHandlers({
  host,
  secrets,
  paths,
  log,
  copilot,
  hotkeys,
  updates,
  phone,
  mainWindow,
}: Context): InvokeHandlers {
  /** Checks a key with Google, keeps it in the OS-protected store and makes it active. */
  const saveKey = async (provider: ProviderId, key: string, origin: KeyOrigin) => {
    if (secrets.level === 'unavailable') {
      throw new AppError(
        'secure_storage_unavailable',
        "This system's secure storage isn't available, so the key can't be saved safely.",
      );
    }
    const { verification, models } = await host.call(
      'apiKey.verify',
      { provider, key },
      PROVIDER_CALL,
    );
    if (verification.outcome === 'invalid') {
      throw new AppError('invalid_api_key', verification.message ?? 'Google rejected this key.');
    }
    await secrets.set(apiKeySecretRef(provider), key);
    return host.call('apiKey.activate', { provider, key, verification, models, origin });
  };

  return {
    ...forwardedHandlers(host),

    'app:getInfo': (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      isPackaged: app.isPackaged,
      userDataDir: paths.userData,
      logsDir: paths.logs,
      secureStorage: secrets.level,
    }),

    'app:openPath': async (which) => {
      const error = await shell.openPath(which === 'logs' ? paths.logs : paths.userData);
      if (error) throw new AppError('internal', error);
    },

    'app:openExternal': async (url) => {
      await shell.openExternal(url);
    },

    'app:deleteAllData': async () => {
      log.warn('deleting all local data at user request');
      await host.stop();
      rmSync(paths.dataDir, { recursive: true, force: true });
      rmSync(paths.secrets, { force: true });
      rmSync(paths.uiCache, { force: true });
      await host.restart();
      broadcast('settings:changed', await host.call('settings.get'));
      for (const provider of PROVIDERS) {
        broadcast('apiKey:changed', await host.call('apiKey.status', { provider }));
      }
      log.info('local data deleted; started fresh');
    },

    'engine:getStatus': () => host.status,

    'settings:get': () => host.call('settings.get'),

    'settings:update': (patch) => host.call('settings.update', patch),

    'apiKey:getStatus': ({ provider }) => host.call('apiKey.status', { provider }),

    'apiKey:save': ({ provider, key }) =>
      saveKey(provider, key, { source: 'typed', label: null, expiresAt: null }),

    'apiKey:importFile': async ({ provider, data, password }) => {
      const file = await readKeyFile(data, password);
      if (file.expiresAt !== null && Date.now() > file.expiresAt) {
        throw new AppError(
          'invalid_input',
          `This key file expired on ${expiryText(file.expiresAt)}. Ask for a new one.`,
        );
      }
      log.info('importing a key file', { expires: file.expiresAt !== null });
      return saveKey(provider, file.key, {
        source: 'file',
        label: file.label || null,
        expiresAt: file.expiresAt,
      });
    },

    'apiKey:createFile': async ({ provider, key, password, label, expiresAt }) => {
      // Don't hand out a key that doesn't work.
      const { verification } = await host.call('apiKey.verify', { provider, key }, PROVIDER_CALL);
      if (verification.outcome === 'invalid') {
        throw new AppError('invalid_api_key', verification.message ?? 'Google rejected this key.');
      }
      const bytes = await createKeyFile({ key, label, expiresAt }, password);
      const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      const options = {
        title: 'Save key file',
        defaultPath: join(
          app.getPath('documents'),
          `gemini-key${slug ? `-${slug}` : ''}.${KEY_FILE_EXTENSION}`,
        ),
        filters: [{ name: 'Key file', extensions: [KEY_FILE_EXTENSION] }],
      };
      const parent = mainWindow() ?? BrowserWindow.getFocusedWindow();
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, bytes);
      log.info('key file created', { expires: expiresAt !== null });
      return { saved: true };
    },

    'apiKey:verify': ({ provider }) => host.call('apiKey.recheck', { provider }, PROVIDER_CALL),

    'apiKey:remove': async ({ provider }) => {
      await secrets.delete(apiKeySecretRef(provider));
      return host.call('apiKey.clear', { provider });
    },

    'models:list': (params) => host.call('models.list', params, PROVIDER_CALL),

    'sessions:saveTranscript': async ({ id, format, includeAnswers }) => {
      const { fileName, text } = await host.call('sessions.export', {
        id,
        format,
        includeAnswers,
      });
      const options = {
        title: 'Save transcript',
        defaultPath: join(app.getPath('documents'), fileName),
        filters:
          format === 'markdown'
            ? [{ name: 'Markdown', extensions: ['md'] }]
            : [{ name: 'Text', extensions: ['txt'] }],
      };
      const parent = mainWindow() ?? BrowserWindow.getFocusedWindow();
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, text, 'utf8');
      log.info('transcript saved');
      return { saved: true };
    },

    'app:copyText': async (text) => {
      await clipboard.writeText(text);
    },

    'copilot:setVisible': ({ visible }) => {
      if (visible) copilot.show();
      else copilot.hide();
      return copilot.visible;
    },

    'copilot:getVisible': () => copilot.visible,

    'hotkeys:status': () => hotkeys.statuses,
    'app:updateStatus': () => updates.status,
    'app:checkForUpdates': () => updates.check(),
    'app:installUpdate': () => updates.install(),
    'phone:status': () => phone.status,
    'phone:unpair': () => phone.unpair(),
  };
}
