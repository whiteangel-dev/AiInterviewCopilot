import { FREE_PREPARATION_MODEL, type AiProvider, type Logger } from '@aic/core';
import type {
  AnswerRepository,
  AppDatabase,
  KnowledgeRepository,
  ProfileRepository,
  ProviderConfigRepository,
  SessionRepository,
  SettingsRepository,
} from '@aic/db';
import type { EngineEvents, EngineInitParams, ProviderId, Settings } from '@aic/ipc';
import type { Jobs } from './jobs';

export interface Ready {
  db: AppDatabase;
  settingsRepo: SettingsRepository;
  providerRepo: ProviderConfigRepository;
  profiles: ProfileRepository;
  knowledge: KnowledgeRepository;
  answers: AnswerRepository;
  sessions: SessionRepository;
  settings: Settings;
  init: Pick<EngineInitParams, 'appVersion' | 'fakeProvider' | 'nativeAudioPath' | 'audioReplay'>;
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

/**
 * Preparation uses the strongest model, which Google's free tier doesn't
 * include: free keys fall back to a free model instead of failing.
 */
export const PREPARATION_FALLBACK = { fallbackModels: [FREE_PREPARATION_MODEL] } as const;
