import type { Settings, SettingsPatch } from './settings';
import type { ApiKeyStatus, KeyVerification, ModelCatalog, ModelInfo, ProviderId } from './types';

/** Main → engine RPC. Both ends are our own code, so params are not re-validated. */

export interface EngineInitParams {
  dbPath: string;
  /** 32-byte database key, hex. Held only in memory. */
  dbKeyHex: string;
  backupDir: string;
  logDir: string;
  appVersion: string;
  /** Development and tests only: use a fake AI provider that needs no network. */
  fakeProvider: boolean;
}

export interface EngineInitResult {
  schemaVersion: number;
  /** Set when migrations ran on an existing database and a backup was made first. */
  backupPath: string | null;
}

export interface ProviderKeyParams {
  provider: ProviderId;
  key: string;
}

export type EngineMethods = {
  init: { params: EngineInitParams; result: EngineInitResult };
  ping: { params: void; result: { pid: number; uptimeMs: number; rssBytes: number } };
  shutdown: { params: void; result: void };
  'settings.get': { params: void; result: Settings };
  'settings.update': { params: SettingsPatch; result: Settings };
  /** Checks a key against the provider without storing anything. */
  'apiKey.verify': {
    params: ProviderKeyParams;
    result: { verification: KeyVerification; models: ModelInfo[] | null };
  };
  /** Makes a key the active one (in memory) and records its verification. */
  'apiKey.activate': {
    params: ProviderKeyParams & {
      verification: KeyVerification | null;
      models: ModelInfo[] | null;
    };
    result: ApiKeyStatus;
  };
  /** Re-checks the active key with the provider. */
  'apiKey.recheck': { params: { provider: ProviderId }; result: ApiKeyStatus };
  'apiKey.clear': { params: { provider: ProviderId }; result: ApiKeyStatus };
  'apiKey.status': { params: { provider: ProviderId }; result: ApiKeyStatus };
  'models.list': { params: { provider: ProviderId; refresh: boolean }; result: ModelCatalog };
};

export type EngineEvents = {
  'settings.changed': Settings;
  'apiKey.changed': ApiKeyStatus;
};

/** Name of a provider's API key in main's OS-protected secret store. */
export function apiKeySecretRef(provider: ProviderId): string {
  return `apikey.${provider}`;
}
