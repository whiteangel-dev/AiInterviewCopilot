import type { AiProvider, Logger } from '@aic/core';
import type {
  AnswerRepository,
  AppDatabase,
  KnowledgeRepository,
  ProfileRepository,
  ProviderConfigRepository,
  SettingsRepository,
} from '@aic/db';
import type { EngineEvents, ProviderId, Settings } from '@aic/ipc';
import type { Jobs } from './jobs';

export interface Ready {
  db: AppDatabase;
  settingsRepo: SettingsRepository;
  providerRepo: ProviderConfigRepository;
  profiles: ProfileRepository;
  knowledge: KnowledgeRepository;
  answers: AnswerRepository;
  settings: Settings;
  providers: Record<ProviderId, AiProvider>;
}

/** What the engine's feature modules need from the engine. */
export interface EngineContext {
  ready(): Ready;
  /** The active API key, or a `no_api_key` error. */
  requireKey(provider: ProviderId): string;
  emit<K extends keyof EngineEvents>(event: K, data: EngineEvents[K]): void;
  log(): Logger;
  jobs: Jobs;
  /** Today's date as YYYY-MM-DD (injectable for tests). */
  today(): string;
}
