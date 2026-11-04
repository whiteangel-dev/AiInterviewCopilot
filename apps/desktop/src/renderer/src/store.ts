import type {
  ApiKeyStatus,
  AppInfo,
  EngineStatus,
  KnowledgeBaseSummary,
  ProfileSummary,
  SerializedError,
  Settings,
  SettingsPatch,
} from '@aic/ipc';
import { AppError } from '@aic/ipc/errors';
import { create } from 'zustand';
import { invoke, on } from './lib/api';
import { errorMessage } from './lib/utils';

export type Page =
  'home' | 'interview' | 'sessions' | 'profiles' | 'knowledge' | 'answers' | 'audio' | 'settings';

export interface NavigateOptions {
  /** Settings section to scroll to. */
  section?: string;
  /** Open this profile (Profiles page) or select it (Answer bank). */
  profileId?: string | null;
  baseId?: string | null;
  /** Open this session (Sessions page). */
  sessionId?: string | null;
}

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

interface AppState {
  page: Page;
  /** Settings section to scroll to after navigating. */
  focusSection: string | null;
  /** Open profile on the Profiles page (null: the list). */
  profileId: string | null;
  /** Selected knowledge base. */
  baseId: string | null;
  /** Profile the Answer bank shows. */
  answersProfileId: string | null;
  /** Open session on the Sessions page (null: the list). */
  sessionId: string | null;
  profiles: ProfileSummary[] | null;
  bases: KnowledgeBaseSummary[] | null;
  info: AppInfo | null;
  engine: EngineStatus | null;
  settings: Settings | null;
  apiKey: ApiKeyStatus | null;
  /** Set when the engine can't start (e.g. the database can't be unlocked). */
  fatal: SerializedError | null;
  toasts: Toast[];

  navigate: (page: Page, options?: NavigateOptions) => void;
  refreshProfiles: () => Promise<void>;
  refreshBases: () => Promise<void>;
  selectBase: (baseId: string | null) => void;
  selectAnswersProfile: (profileId: string | null) => void;
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
  profileId: null,
  baseId: null,
  answersProfileId: null,
  sessionId: null,
  profiles: null,
  bases: null,
  info: null,
  engine: null,
  settings: null,
  apiKey: null,
  fatal: null,
  toasts: [],

  navigate: (page, options = {}) =>
    set({
      page,
      focusSection: options.section ?? null,
      ...(page === 'profiles' ? { profileId: options.profileId ?? null } : {}),
      ...(page === 'sessions' ? { sessionId: options.sessionId ?? null } : {}),
      ...(page === 'answers' && options.profileId !== undefined
        ? { answersProfileId: options.profileId }
        : {}),
      ...(options.baseId !== undefined ? { baseId: options.baseId } : {}),
    }),

  async refreshProfiles() {
    try {
      set({ profiles: await invoke('profiles:list') });
    } catch (err) {
      get().toast('error', `Couldn't load profiles: ${errorMessage(err)}`);
    }
  },

  async refreshBases() {
    try {
      const bases = await invoke('knowledge:listBases');
      const current = get().baseId;
      set({
        bases,
        baseId: current && bases.some((b) => b.id === current) ? current : (bases[0]?.id ?? null),
      });
    } catch (err) {
      get().toast('error', `Couldn't load knowledge: ${errorMessage(err)}`);
    }
  },

  selectBase: (baseId) => set({ baseId }),
  selectAnswersProfile: (answersProfileId) => set({ answersProfileId }),
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
      await Promise.all([get().refreshProfiles(), get().refreshBases()]);
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
