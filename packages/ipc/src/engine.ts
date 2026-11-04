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
import type {
  AnswerLength,
  AudioEnvironment,
  LiveAnswer,
  LiveMeter,
  LiveStartParams,
  LiveState,
  LiveTranscript,
  LiveTranscriptUpdate,
  LiveTurnUpdate,
  SessionDetail,
  SessionSummary,
  TranscriptFormat,
} from './live';
import type { Settings, SettingsPatch } from './settings';
import type {
  ApiKeyStatus,
  KeyOrigin,
  KeyVerification,
  ModelCatalog,
  ModelInfo,
  ProviderId,
} from './types';

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
  /** The native audio module (`aic_native_audio.node`), or null if this build has none. */
  nativeAudioPath: string | null;
  /** Development and tests only: play these 16 kHz mono WAVs instead of capturing. */
  audioReplay: { interviewer: string | null; candidate: string | null } | null;
}

/** Asks main to start Electron's built-in capture and connect it to the engine. */
export interface CaptureRequest {
  runId: string;
  microphone: boolean;
  system: boolean;
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
      /** Given when a key is newly saved; at startup the stored origin is kept. */
      origin?: KeyOrigin;
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

  // Live listening (Phase 3). One live run at a time: an interview or an audio test.
  'audio.environment': { params: { refresh: boolean }; result: AudioEnvironment };
  'live.start': { params: LiveStartParams; result: LiveState };
  'live.pause': { params: void; result: LiveState | null };
  'live.resume': { params: void; result: LiveState | null };
  'live.stop': { params: void; result: LiveState | null };
  'live.state': { params: void; result: LiveState | null };
  /** The current run's transcript, for a window that opens mid-session. */
  'live.transcript': { params: void; result: LiveTranscript | null };
  /** A plain-text report for troubleshooting (no audio, no transcript text). */
  'live.diagnostics': { params: void; result: string };
  /** Electron's built-in capture failed to start or stopped (reported by main). */
  'capture.failed': { params: { runId: string; message: string }; result: void };
  /** The current run's answers, oldest first (for a window that opens mid-session). */
  'live.answers': { params: void; result: LiveAnswer[] };
  /** Answers the interviewer's current turn now, without waiting for turn detection. */
  'live.answerNow': { params: void; result: void };
  /** Writes a new answer to the same question, optionally at another length. */
  'live.regenerate': {
    params: { answerId: string | null; length: AnswerLength | null };
    result: void;
  };

  'sessions.list': { params: void; result: SessionSummary[] };
  'sessions.get': { params: { id: string }; result: SessionDetail };
  'sessions.rename': { params: { id: string; title: string }; result: SessionSummary };
  'sessions.delete': { params: { id: string }; result: void };
  'sessions.export': {
    params: { id: string; format: TranscriptFormat; includeAnswers: boolean };
    result: { fileName: string; text: string };
  };
};

export type EngineEvents = {
  'settings.changed': Settings;
  'apiKey.changed': ApiKeyStatus;
  'job.progress': JobProgress;
  /** null when no run is active. */
  'live.state': LiveState | null;
  'live.meter': LiveMeter;
  'live.transcript': LiveTranscriptUpdate;
  /** A new or updated answer (the whole answer each time, also while it streams). */
  'live.answer': LiveAnswer;
  'live.turn': LiveTurnUpdate;
  'capture.open': CaptureRequest;
  'capture.close': { runId: string };
};

/** Main → engine messages that carry a MessagePort (outside the RPC protocol). */
export interface EnginePortMessage {
  kind: 'port';
  purpose: 'capture';
  runId: string;
}

/**
 * What Electron's built-in capture page sends over its port: frames of 16 kHz
 * mono PCM16 (20 ms each) and status changes per channel.
 */
export type CapturePortMessage =
  | { kind: 'frame'; channel: 'interviewer' | 'candidate'; pcm: ArrayBuffer }
  | {
      kind: 'status';
      channel: 'interviewer' | 'candidate';
      status: 'opened' | 'ended' | 'error';
      message: string;
      device: string | null;
    };

/** Name of a provider's API key in main's OS-protected secret store. */
export function apiKeySecretRef(provider: ProviderId): string {
  return `apikey.${provider}`;
}
