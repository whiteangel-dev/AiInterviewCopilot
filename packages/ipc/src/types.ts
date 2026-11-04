import { z } from 'zod';
import type { SerializedError } from './errors';
import type { ModelRoles } from './settings';

export const PROVIDERS = ['gemini'] as const;
export const ProviderIdSchema = z.enum(PROVIDERS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export type ModelKind = 'text' | 'live' | 'tts' | 'embedding' | 'image' | 'other';

export interface ModelInfo {
  /** Model ID without the `models/` prefix, e.g. `gemini-3.5-flash-lite`. */
  id: string;
  displayName: string;
  kind: ModelKind;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
}

export interface ModelCatalog {
  provider: ProviderId;
  models: ModelInfo[];
  /** Epoch ms of the last successful fetch from the provider. */
  fetchedAt: number;
  /** Best available model per role, chosen from `models`. */
  recommended: Partial<ModelRoles>;
}

export type KeyVerificationOutcome = 'valid' | 'invalid' | 'unverified';

export interface KeyVerification {
  outcome: KeyVerificationOutcome;
  /** Why the key is invalid or couldn't be checked. Never contains the key. */
  message: string | null;
  checkedAt: number;
}

export interface ApiKeyStatus {
  provider: ProviderId;
  configured: boolean;
  /** Last 4 characters, to tell keys apart. Never more. */
  hint: string | null;
  verification: KeyVerificationOutcome;
  message: string | null;
  checkedAt: number | null;
  /** `file`: imported from an encrypted key file someone gave you. */
  source: KeyOrigin['source'];
  /** The key file's label ("For Alex"). */
  label: string | null;
  /** After this (epoch ms) the app stops using a key file's key. */
  expiresAt: number | null;
  expired: boolean;
}

/** Where the active key came from. */
export interface KeyOrigin {
  source: 'typed' | 'file';
  label: string | null;
  expiresAt: number | null;
}

/** How API keys and the database key are protected at rest. */
export type SecureStorageLevel = 'os' | 'weak' | 'unavailable';

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  versions: { electron: string; chrome: string; node: string };
  isPackaged: boolean;
  userDataDir: string;
  logsDir: string;
  secureStorage: SecureStorageLevel;
}

/**
 * Automatic updates from GitHub Releases. `disabled` in development builds;
 * `ready`: downloaded, installs on restart (or the next time the app quits).
 */
export type UpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'idle'; checkedAt: number | null }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

/** The phone second screen (a local web page, Phase 8). */
export interface PhoneStatus {
  enabled: boolean;
  /** Serving on the local network. */
  running: boolean;
  /** Links with the pairing token, one per local address (the first goes in the QR code). */
  urls: string[];
  /** Phones connected right now. */
  clients: number;
  /** Why it isn't running, when it should be. */
  error: string | null;
}

export type EngineState = 'starting' | 'ready' | 'restarting' | 'failed';

export interface EngineStatus {
  state: EngineState;
  /** Set when `state` is `failed`, or for the last crash while `restarting`. */
  error: SerializedError | null;
  restarts: number;
  /** Database schema version after migrations, once ready. */
  schemaVersion: number | null;
}
