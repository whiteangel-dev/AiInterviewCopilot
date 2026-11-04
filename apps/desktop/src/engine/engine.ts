import { join } from 'node:path';
import {
  FakeProvider,
  GeminiProvider,
  createLogger,
  recommendModels,
  registerSecret,
  unregisterSecret,
  verifyApiKey,
  type Logger,
} from '@aic/core';
import {
  AnswerRepository,
  KnowledgeRepository,
  openDatabase,
  ProfileRepository,
  ProviderConfigRepository,
  SessionRepository,
  SettingsRepository,
} from '@aic/db';
import {
  AppError,
  apiKeySecretRef,
  applySettingsPatch,
  type ApiKeyStatus,
  type EngineEvents,
  type EngineMethods,
  type EnginePortMessage,
  type ModelInfo,
  type ProviderId,
  type RpcHandlers,
} from '@aic/ipc';
import { answerHandlers } from './answers';
import type { EngineContext, Ready } from './context';
import { Jobs } from './jobs';
import { knowledgeHandlers } from './knowledge';
import type { PortLike } from './audio-sources';
import { profileHandlers } from './profiles';
import { sessionModule } from './sessions';

/** Cached model lists older than this are refreshed on the next request. */
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface EngineDeps {
  emit<K extends keyof EngineEvents>(event: K, data: EngineEvents[K]): void;
  /** Called after `shutdown` has responded. */
  exit(code: number): void;
  /** Log to stderr as well as the file (development). */
  logToConsole: boolean;
  /** Today's date (YYYY-MM-DD); defaults to the local date. */
  today?: () => string;
}

function localDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The engine's request handlers. Owns the database and holds API keys in memory
 * only; keys arrive from the main process, which keeps them OS-encrypted at rest.
 */
export function createEngine(deps: EngineDeps): {
  handlers: RpcHandlers<EngineMethods>;
  logger(): Logger;
  attachPort(message: EnginePortMessage, port: PortLike): void;
} {
  const startedAt = Date.now();
  let log: Logger = createLogger({ console: true, scope: 'engine' });
  let state: Ready | null = null;
  const keys = new Map<ProviderId, string>();

  const ready = (): Ready => {
    if (!state) throw new AppError('engine_unavailable', 'The engine has not finished starting.');
    return state;
  };

  const requireKey = (provider: ProviderId): string => {
    const key = keys.get(provider);
    if (!key) throw new AppError('no_api_key', 'Add your Gemini API key in Settings first.');
    return key;
  };

  const keyStatus = (provider: ProviderId): ApiKeyStatus => {
    const row = ready().providerRepo.get(provider);
    const configured = keys.has(provider);
    return {
      provider,
      configured,
      hint: configured ? (row?.keyHint ?? null) : null,
      verification: configured ? (row?.verification ?? 'unverified') : 'unverified',
      message: configured ? (row?.verificationMessage ?? null) : null,
      checkedAt: configured ? (row?.checkedAt ?? null) : null,
    };
  };

  const changed = (provider: ProviderId): ApiKeyStatus => {
    const status = keyStatus(provider);
    deps.emit('apiKey.changed', status);
    return status;
  };

  const jobs = new Jobs((progress) => deps.emit('job.progress', progress));
  const ctx: EngineContext = {
    ready,
    requireKey,
    emit: (event, data) => deps.emit(event, data),
    log: () => log,
    jobs,
    today: deps.today ?? localDate,
  };

  const sessions = sessionModule(ctx);

  const handlers: RpcHandlers<EngineMethods> = {
    ...profileHandlers(ctx),
    ...knowledgeHandlers(ctx),
    ...answerHandlers(ctx),
    ...sessions.handlers,

    'jobs.cancel': ({ jobId }) => jobs.cancel(jobId),

    init(params) {
      if (state) throw new AppError('internal', 'The engine is already initialized.');
      log.close();
      log = createLogger({
        file: join(params.logDir, 'engine.log'),
        console: deps.logToConsole,
        scope: 'engine',
      });
      registerSecret(params.dbKeyHex);

      const db = openDatabase({
        path: params.dbPath,
        keyHex: params.dbKeyHex,
        backupDir: params.backupDir,
      });
      const settingsRepo = new SettingsRepository(db.db);
      state = {
        db,
        settingsRepo,
        providerRepo: new ProviderConfigRepository(db.db),
        profiles: new ProfileRepository(db.db),
        knowledge: new KnowledgeRepository(db.db),
        answers: new AnswerRepository(db.db),
        sessions: new SessionRepository(db.db),
        settings: settingsRepo.load(),
        providers: { gemini: params.fakeProvider ? new FakeProvider() : new GeminiProvider() },
        init: {
          appVersion: params.appVersion,
          fakeProvider: params.fakeProvider,
          nativeAudioPath: params.nativeAudioPath,
          audioReplay: params.audioReplay,
        },
      };
      sessions.onReady();
      log.info('database ready', {
        schemaVersion: db.schemaVersion,
        backup: db.backupPath !== null,
        fakeProvider: params.fakeProvider,
        appVersion: params.appVersion,
      });
      return { schemaVersion: db.schemaVersion, backupPath: db.backupPath };
    },

    ping() {
      return {
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        rssBytes: process.memoryUsage().rss,
      };
    },

    shutdown() {
      log.info('shutting down');
      if (state) sessions.shutdown();
      state?.db.close();
      state = null;
      log.close();
      setTimeout(() => deps.exit(0), 10);
    },

    'settings.get': () => ready().settings,

    'settings.update'(patch) {
      const s = ready();
      const { settings, changed: sections } = applySettingsPatch(s.settings, patch);
      if (sections.length > 0) {
        s.settingsRepo.save(settings, sections);
        s.settings = settings;
        deps.emit('settings.changed', settings);
      }
      return settings;
    },

    async 'apiKey.verify'({ provider, key }) {
      const result = await verifyApiKey(ready().providers[provider], key);
      log.info('key checked', { provider, outcome: result.verification.outcome });
      return result;
    },

    'apiKey.activate'({ provider, key, verification, models }) {
      const s = ready();
      const previous = keys.get(provider);
      if (previous && previous !== key) unregisterSecret(previous);
      keys.set(provider, key);
      registerSecret(key);

      const hint = key.slice(-4);
      const row = s.providerRepo.get(provider);
      // At startup (no verification) keep the stored status unless the key changed.
      if (verification || !row || row.keyHint !== hint || !row.keyRef) {
        s.providerRepo.setKey(
          provider,
          { ref: apiKeySecretRef(provider), hint },
          verification,
          models,
        );
      }
      return verification ? changed(provider) : keyStatus(provider);
    },

    async 'apiKey.recheck'({ provider }) {
      const s = ready();
      const { verification, models } = await verifyApiKey(
        s.providers[provider],
        requireKey(provider),
      );
      s.providerRepo.recordVerification(provider, verification);
      if (models) s.providerRepo.saveModels(provider, models, verification.checkedAt);
      log.info('key rechecked', { provider, outcome: verification.outcome });
      return changed(provider);
    },

    'apiKey.clear'({ provider }) {
      const s = ready();
      const key = keys.get(provider);
      if (key) unregisterSecret(key);
      keys.delete(provider);
      s.providerRepo.clearKey(provider);
      return changed(provider);
    },

    'apiKey.status': ({ provider }) => keyStatus(provider),

    async 'models.list'({ provider, refresh }) {
      const s = ready();
      const key = requireKey(provider);
      const row = s.providerRepo.get(provider);
      let models: ModelInfo[] | null = row?.modelCatalog ?? null;
      let fetchedAt = row?.modelsFetchedAt ?? 0;

      if (refresh || !models || Date.now() - fetchedAt > MODEL_CACHE_TTL_MS) {
        const ai = s.providers[provider];
        try {
          models = await ai.listModels(key);
          fetchedAt = Date.now();
          s.providerRepo.saveModels(provider, models, fetchedAt);
          if (row?.verification !== 'valid') {
            s.providerRepo.recordVerification(provider, {
              outcome: 'valid',
              message: null,
              checkedAt: fetchedAt,
            });
            changed(provider);
          }
        } catch (err) {
          const error = ai.toAppError(err);
          if (error.code === 'invalid_api_key') {
            s.providerRepo.recordVerification(provider, {
              outcome: 'invalid',
              message: error.message,
              checkedAt: Date.now(),
            });
            changed(provider);
            throw error;
          }
          if (!models) throw error;
          log.warn('model list refresh failed; using cached list', { provider, code: error.code });
        }
      }
      return { provider, models, fetchedAt, recommended: recommendModels(models) };
    },
  };

  return {
    handlers,
    logger: () => log,
    attachPort: (message, port) => {
      if (!state) port.close();
      else sessions.attachPort(message, port);
    },
  };
}
