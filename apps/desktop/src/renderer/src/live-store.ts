import type {
  AudioChannel,
  LiveMeter,
  LiveStartParams,
  LiveState,
  LiveSuggestion,
  TranscriptSegment,
} from '@aic/ipc';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { invoke, on } from './lib/api';

/** Most segments kept in memory for display (the full transcript is saved). */
const MAX_SEGMENTS = 2000;

interface LiveStore {
  state: LiveState | null;
  meter: LiveMeter | null;
  segments: TranscriptSegment[];
  interim: Partial<Record<AudioChannel, TranscriptSegment>>;
  suggestion: LiveSuggestion | null;
  copilotVisible: boolean;
  /** Subscribes to live events (once) and loads the current run. */
  init: () => Promise<void>;
  start: (params: LiveStartParams) => Promise<LiveState>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  setCopilotVisible: (visible: boolean) => Promise<void>;
}

let subscribed = false;

export const useLive = create<LiveStore>()((set, get) => {
  /** Loads the transcript so far (a window opened mid-session). */
  const loadTranscript = async () => {
    const t = await invoke('live:transcript');
    if (!t || t.id !== get().state?.id) return;
    set({ segments: t.segments.slice(-MAX_SEGMENTS), interim: t.interim });
  };

  const setState = (state: LiveState | null) => {
    const previous = get().state;
    if (state?.mode === 'test' && state.status === 'live') markAudioTested();
    if (state?.id !== previous?.id) {
      set({ state, segments: [], interim: {}, meter: null, suggestion: null });
      if (state) void loadTranscript();
    } else {
      set({ state });
    }
  };

  return {
    state: null,
    meter: null,
    segments: [],
    interim: {},
    suggestion: null,
    copilotVisible: false,

    async init() {
      if (!subscribed) {
        subscribed = true;
        on('live:state', setState);
        on('live:meter', (meter) => {
          if (meter.id === get().state?.id) set({ meter });
        });
        on('live:transcript', (update) => {
          if (update.id !== get().state?.id) return;
          const { segment } = update;
          if (update.kind === 'interim') {
            const interim = { ...get().interim };
            if (segment.text) interim[segment.channel] = segment;
            else delete interim[segment.channel];
            set({ interim });
          } else {
            const interim = { ...get().interim };
            delete interim[segment.channel];
            const segments = [...get().segments, segment].sort((a, b) => a.startMs - b.startMs);
            set({ segments: segments.slice(-MAX_SEGMENTS), interim });
          }
        });
        on('live:suggestion', (suggestion) => {
          if (!suggestion || suggestion.id === get().state?.id) set({ suggestion });
        });
        on('copilot:visibility', (copilotVisible) => set({ copilotVisible }));
      }
      const [state, copilotVisible] = await Promise.all([
        invoke('live:state'),
        invoke('copilot:getVisible'),
      ]);
      set({ copilotVisible });
      setState(state);
    },

    async start(params) {
      const state = await invoke('live:start', params);
      setState(state);
      return state;
    },
    async pause() {
      setState(await invoke('live:pause'));
    },
    async resume() {
      setState(await invoke('live:resume'));
    },
    async stop() {
      setState(await invoke('live:stop'));
    },
    async setCopilotVisible(visible) {
      set({ copilotVisible: await invoke('copilot:setVisible', { visible }) });
    },
  };
});

const TESTED_KEY = 'aic:audio-tested';

function markAudioTested(): void {
  try {
    localStorage.setItem(TESTED_KEY, '1');
  } catch {
    // storage unavailable: the checklist just won't remember
  }
}

/** Whether the user has run an audio test on this computer. */
export function audioTestedBefore(): boolean {
  try {
    return localStorage.getItem(TESTED_KEY) === '1';
  } catch {
    return false;
  }
}

/** "mm:ss" or "h:mm:ss". */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** Listening time of a run, ticking every second while it's live. */
export function useElapsed(state: LiveState | null): number {
  const [now, setNow] = useState(() => Date.now());
  const live = state?.status === 'live';
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!state) return 0;
  return live ? state.elapsedMs + Math.max(0, now - state.updatedAt) : state.elapsedMs;
}

/** True while a run is starting, live or paused. */
export function isActive(state: LiveState | null): boolean {
  return (
    !!state && (state.status === 'starting' || state.status === 'live' || state.status === 'paused')
  );
}
