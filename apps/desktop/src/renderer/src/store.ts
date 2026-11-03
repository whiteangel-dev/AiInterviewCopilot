import type {
  ApiKeyStatus,
  AppInfo,
  EngineStatus,
  SerializedError,
  Settings,
  SettingsPatch,
} from '@aic/ipc';
import { AppError } from '@aic/ipc/errors';
import { create } from 'zustand';
import { invoke, on } from './lib/api';
import { errorMessage } from './lib/utils';

export type Page = 'home' | 'settings';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

interface AppState {
  page: Page;
  /** Settings section to scroll to after navigating. */
  focusSection: string | null;
  info: AppInfo | null;
  engine: EngineStatus | null;
  settings: Settings | null;
  apiKey: ApiKeyStatus | null;
  /** Set when the engine can't start (e.g. the database can't be unlocked). */
  fatal: SerializedError | null;
  toasts: Toast[];

  navigate: (page: Page, section?: string) => void;
  clearFocusSection: () => void;
  boot: () => Promise<void>;
  reload: () => Promise<void>;
  updateSettings: (patch: SettingsPatch) => Promise<void>;
  setApiKey: (status: ApiKeyStatus) => void;
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;
let subscribed = false;

export const useApp = create<AppState>()((set, get) => ({
  page: 'home',
  focusSection: null,
  info: null,
  engine: null,
  settings: null,
  apiKey: null,
  fatal: null,
  toasts: [],

  navigate: (page, section) => set({ page, focusSection: section ?? null }),
  clearFocusSection: () => set({ focusSection: null }),

  async boot() {
    if (!subscribed) {
      subscribed = true;
      on('engine:status', (engine) => {
        const wasReady = get().engine?.state === 'ready';
        set({ engine, fatal: engine.state === 'failed' ? engine.error : null });
        if (engine.state === 'ready' && !wasReady) void get().reload();
      });
      on('settings:changed', (settings) => set({ settings }));
      on('apiKey:changed', (apiKey) => set({ apiKey }));
    }
    const [info, engine] = await Promise.all([invoke('app:getInfo'), invoke('engine:getStatus')]);
    set({ info, engine, fatal: engine.state === 'failed' ? engine.error : null });
    if (engine.state !== 'failed') await get().reload();
  },

  async reload() {
    try {
      const [settings, apiKey] = await Promise.all([
        invoke('settings:get'),
        invoke('apiKey:getStatus', { provider: 'gemini' }),
      ]);
      set({ settings, apiKey, fatal: null });
    } catch (err) {
      const error = AppError.from(err);
      if (error.code === 'engine_unavailable' && get().engine?.state !== 'failed') return;
      set({ fatal: error.toJSON() });
    }
  },

  async updateSettings(patch) {
    const before = get().settings;
    if (before) {
      // Optimistic: apply locally, then confirm (or roll back) with the engine.
      const next = structuredClone(before);
      for (const [section, values] of Object.entries(patch)) {
        Object.assign(next[section as keyof Settings], values);
      }
      set({ settings: next });
    }
    try {
      set({ settings: await invoke('settings:update', patch) });
    } catch (err) {
      set({ settings: before });
      get().toast('error', `Couldn't save the setting: ${errorMessage(err)}`);
    }
  },

  setApiKey: (apiKey) => set({ apiKey }),

  toast(kind, message) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, message }] });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
