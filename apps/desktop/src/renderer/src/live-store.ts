import type {
  AnswerLength,
  AudioChannel,
  LiveAnswer,
  LiveMeter,
  LiveStartParams,
  LiveState,
  TranscriptSegment,
  TurnPhase,
} from '@aic/ipc';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { invoke, on } from './lib/api';

/** Most segments kept in memory for display (the full transcript is saved). */
const MAX_SEGMENTS = 2000;
/** Most answers kept in memory for display (all are saved). */
const MAX_ANSWERS = 100;

interface LiveStore {
  state: LiveState | null;
  meter: LiveMeter | null;
  segments: TranscriptSegment[];
  interim: Partial<Record<AudioChannel, TranscriptSegment>>;
  /** Answers shown in this run, oldest first (withdrawn ones removed). */
  answers: LiveAnswer[];
  /** What the copilot is doing about the interviewer's current turn. */
  phase: TurnPhase;
  copilotVisible: boolean;
  /** Subscribes to live events (once) and loads the current run. */
  init: () => Promise<void>;
  start: (params: LiveStartParams) => Promise<LiveState>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  answerNow: () => Promise<void>;
  regenerate: (answerId: string | null, length: AnswerLength | null) => Promise<void>;
  setCopilotVisible: (visible: boolean) => Promise<void>;
}

/** Adds or replaces an answer; withdrawn answers are removed. */
function upsertAnswer(answers: LiveAnswer[], answer: LiveAnswer): LiveAnswer[] {
  const i = answers.findIndex((a) => a.id === answer.id);
  if (answer.status === 'withdrawn') return i < 0 ? answers : answers.filter((_, j) => j !== i);
  if (i >= 0) return answers.map((a, j) => (j === i ? answer : a));
  return [...answers, answer].slice(-MAX_ANSWERS);
}

let subscribed = false;

export const useLive = create<LiveStore>()((set, get) => {
  /** Loads the transcript and answers so far (a window opened mid-session). */
  const loadTranscript = async () => {
    const [t, answers] = await Promise.all([invoke('live:transcript'), invoke('live:answers')]);
    const id = get().state?.id;
    if (t && t.id === id) set({ segments: t.segments.slice(-MAX_SEGMENTS), interim: t.interim });
    const mine = answers.filter((a) => a.runId === id);
    if (mine.length) {
      // Keep anything that streamed in meanwhile.
      set({ answers: mine.reduce(upsertAnswer, get().answers).slice(-MAX_ANSWERS) });
    }
  };

  const setState = (state: LiveState | null) => {
    const previous = get().state;
    if (state?.mode === 'test' && state.status === 'live') markAudioTested();
    if (state?.id !== previous?.id) {
      set({ state, segments: [], interim: {}, meter: null, answers: [], phase: 'idle' });
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
    answers: [],
    phase: 'idle',
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
        on('live:answer', (answer) => {
          if (answer.runId === get().state?.id)
            set({ answers: upsertAnswer(get().answers, answer) });
        });
        on('live:turn', (update) => {
          if (update.id === get().state?.id) set({ phase: update.phase });
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
    async answerNow() {
      await invoke('live:answerNow');
    },
    async regenerate(answerId, length) {
      await invoke('live:regenerate', { answerId, length });
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
