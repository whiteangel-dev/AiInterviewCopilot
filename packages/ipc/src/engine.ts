import type { AnswerMatch, PreparedAnswer, PreparedAnswerFields } from './answers';
import type {
  ContextPreview,
  KnowledgeAnalysis,
  KnowledgeBaseDetail,
  KnowledgeBaseSummary,
  KnowledgeItem,
  KnowledgeItemFields,
} from './knowledge';
import type {
  CandidateProfile,
  JobProgress,
  ProfileDetail,
  ProfileSummary,
  TextQuality,
} from './profile';
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

  // Long-running AI jobs take a caller-chosen jobId for progress events and cancel.
  'jobs.cancel': { params: { jobId: string }; result: void };

  'profiles.list': { params: void; result: ProfileSummary[] };
  'profiles.get': { params: { id: string }; result: ProfileDetail };
  /** Imports a resume into a new profile, or into `profileId` as a new version. */
  'profiles.import': {
    params: { jobId: string; fileName: string; data: Uint8Array; profileId: string | null };
    result: ProfileDetail;
  };
  'profiles.reanalyze': { params: { jobId: string; id: string }; result: ProfileDetail };
  'profiles.saveVersion': { params: { id: string; data: CandidateProfile }; result: ProfileDetail };
  'profiles.restoreVersion': { params: { id: string; versionId: string }; result: ProfileDetail };
  'profiles.rename': { params: { id: string; name: string }; result: ProfileDetail };
  'profiles.delete': { params: { id: string }; result: void };
  'profiles.resumeText': {
    params: { id: string };
    result: { text: string; textQuality: TextQuality } | null;
  };

  'knowledge.listBases': { params: void; result: KnowledgeBaseSummary[] };
  'knowledge.getBase': { params: { id: string }; result: KnowledgeBaseDetail };
  'knowledge.createBase': {
    params: { name: string; description: string };
    result: KnowledgeBaseDetail;
  };
  'knowledge.updateBase': {
    params: { id: string; name?: string | undefined; description?: string | undefined };
    result: KnowledgeBaseDetail;
  };
  'knowledge.deleteBase': { params: { id: string }; result: void };
  'knowledge.addItems': {
    params: { baseId: string; items: KnowledgeItemFields[] };
    result: KnowledgeItem[];
  };
  'knowledge.updateItem': {
    params: { id: string; fields: KnowledgeItemFields };
    result: KnowledgeItem;
  };
  'knowledge.deleteItem': { params: { id: string }; result: void };
  'knowledge.analyze': {
    params: { jobId: string; baseId: string; profileId: string | null };
    result: KnowledgeAnalysis;
  };
  /** Splits free-form notes into proposed items; nothing is saved. */
  'knowledge.splitNotes': {
    params: { jobId: string; text: string };
    result: KnowledgeItemFields[];
  };
  'context.preview': {
    params: { profileId: string | null; baseId: string | null };
    result: ContextPreview;
  };

  'answers.list': { params: { profileId: string }; result: PreparedAnswer[] };
  /** Drafts answers for questions not yet in the bank. Returns the whole bank. */
  'answers.generate': {
    params: { jobId: string; profileId: string; baseId: string | null };
    result: PreparedAnswer[];
  };
  'answers.add': {
    params: { profileId: string; fields: PreparedAnswerFields };
    result: PreparedAnswer;
  };
  'answers.update': {
    params: { id: string; fields: PreparedAnswerFields };
    result: PreparedAnswer;
  };
  'answers.delete': { params: { id: string }; result: void };
  'answers.match': { params: { profileId: string; question: string }; result: AnswerMatch[] };
};

export type EngineEvents = {
  'settings.changed': Settings;
  'apiKey.changed': ApiKeyStatus;
  'job.progress': JobProgress;
};

/** Name of a provider's API key in main's OS-protected secret store. */
export function apiKeySecretRef(provider: ProviderId): string {
  return `apikey.${provider}`;
}
