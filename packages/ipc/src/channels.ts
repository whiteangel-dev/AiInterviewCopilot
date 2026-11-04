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
  // Forwarded to the engine as-is (see FORWARDED_CHANNELS in contract.ts).
  'jobs:cancel',
  'profiles:list',
  'profiles:get',
  'profiles:import',
  'profiles:reanalyze',
  'profiles:saveVersion',
  'profiles:restoreVersion',
  'profiles:rename',
  'profiles:delete',
  'profiles:resumeText',
  'knowledge:listBases',
  'knowledge:getBase',
  'knowledge:createBase',
  'knowledge:updateBase',
  'knowledge:deleteBase',
  'knowledge:addItems',
  'knowledge:updateItem',
  'knowledge:deleteItem',
  'knowledge:analyze',
  'knowledge:splitNotes',
  'context:preview',
  'answers:list',
  'answers:generate',
  'answers:add',
  'answers:update',
  'answers:delete',
  'answers:match',
  'audio:environment',
  'live:start',
  'live:pause',
  'live:resume',
  'live:stop',
  'live:state',
  'live:transcript',
  'live:diagnostics',
  'live:answers',
  'live:answerNow',
  'live:regenerate',
  'sessions:list',
  'sessions:get',
  'sessions:rename',
  'sessions:delete',
  // Handled in main.
  'sessions:saveTranscript',
  'app:copyText',
  'copilot:setVisible',
  'copilot:getVisible',
  'hotkeys:status',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

export const EVENT_CHANNELS = [
  'engine:status',
  'settings:changed',
  'apiKey:changed',
  'job:progress',
  'live:state',
  'live:meter',
  'live:transcript',
  'live:answer',
  'live:turn',
  'copilot:visibility',
  'hotkeys:status',
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** Prefix for ipcMain/ipcRenderer channel names, so they can't collide with Electron's. */
export const IPC_PREFIX = 'aic:';

/** What the preload exposes as `window.aic`. Payloads are checked in main. */
export interface AicBridge {
  invoke(channel: InvokeChannel, input?: unknown): Promise<unknown>;
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void;
  readonly platform: string;
}
