import { rmSync } from 'node:fs';
import { app, shell } from 'electron';
import type { Logger } from '@aic/core';
import { AppError, PROVIDERS, apiKeySecretRef, type AppInfo } from '@aic/ipc';
import type { EngineHost } from './engine-host';
import { broadcast, type InvokeHandlers } from './ipc';
import type { AppPaths } from './paths';
import type { SecretStore } from './secret-store';

interface Context {
  host: EngineHost;
  secrets: SecretStore;
  paths: AppPaths;
  log: Logger;
}

/** Network calls to the provider can be slow; allow more than the default RPC timeout. */
const PROVIDER_CALL = { timeoutMs: 30_000 };

export function createInvokeHandlers({ host, secrets, paths, log }: Context): InvokeHandlers {
  return {
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

    'apiKey:save': async ({ provider, key }) => {
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
      return host.call('apiKey.activate', { provider, key, verification, models });
    },

    'apiKey:verify': ({ provider }) => host.call('apiKey.recheck', { provider }, PROVIDER_CALL),

    'apiKey:remove': async ({ provider }) => {
      await secrets.delete(apiKeySecretRef(provider));
      return host.call('apiKey.clear', { provider });
    },

    'models:list': (params) => host.call('models.list', params, PROVIDER_CALL),
  };
}
