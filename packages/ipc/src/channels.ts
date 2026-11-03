/**
 * Channel names only (no schemas), for the sandboxed preload's allowlist.
 * `contract.ts` checks at compile time that these match the typed contract.
 */
export const INVOKE_CHANNELS = [
  'app:getInfo',
  'app:openPath',
  'app:openExternal',
  'app:deleteAllData',
  'engine:getStatus',
  'settings:get',
  'settings:update',
  'apiKey:getStatus',
  'apiKey:save',
  'apiKey:verify',
  'apiKey:remove',
  'models:list',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

export const EVENT_CHANNELS = ['engine:status', 'settings:changed', 'apiKey:changed'] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** Prefix for ipcMain/ipcRenderer channel names, so they can't collide with Electron's. */
export const IPC_PREFIX = 'aic:';

/** What the preload exposes as `window.aic`. Payloads are checked in main. */
export interface AicBridge {
  invoke(channel: InvokeChannel, input?: unknown): Promise<unknown>;
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void;
  readonly platform: string;
}
