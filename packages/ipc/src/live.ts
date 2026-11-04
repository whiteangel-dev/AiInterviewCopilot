import { z } from 'zod';
import type { SerializedError } from './errors';
import { isValidAccelerator } from './hotkeys';

/**
 * Live listening (Phase 3): audio capture, live transcription, interview
 * sessions and their saved transcripts. Live answers (Phase 4): turn detection
 * and answers shown in the copilot.
 */

/** The interviewer is the computer's audio; the candidate is the microphone. */
export const AUDIO_CHANNELS = ['interviewer', 'candidate'] as const;
export type AudioChannel = (typeof AUDIO_CHANNELS)[number];

/** Capture method chosen in settings. */
export const CAPTURE_BACKENDS = ['auto', 'native', 'browser'] as const;
export const CaptureBackendSettingSchema = z.enum(CAPTURE_BACKENDS);
export type CaptureBackendSetting = z.infer<typeof CaptureBackendSettingSchema>;

/**
 * Capture method in use: the Windows audio module, Electron's built-in
 * capture, or recorded files (development and tests only).
 */
export type CaptureBackend = 'native' | 'browser' | 'replay';

export const InterviewerSourceSchema = z.enum(['system', 'app']);
export type InterviewerSource = z.infer<typeof InterviewerSourceSchema>;

export interface AudioDeviceInfo {
  id: string;
  name: string;
  /** `input`: microphones; `output`: speakers and headphones (for system audio). */
  kind: 'input' | 'output';
  isDefault: boolean;
}

/** An app with an audio session, for capturing only that app (Windows 10 2004+). */
export interface AudioAppInfo {
  pid: number;
  /** Executable file name, e.g. `Zoom.exe`. Saved in settings to find the app again. */
  name: string;
  displayName: string;
  /** Playing audio right now. */
  active: boolean;
}

export interface AudioEnvironment {
  platform: string;
  /** What sessions will use with the current settings. */
  backend: CaptureBackend;
  native: { available: boolean; error: string | null; sources: string[] };
  /** Native devices and apps; empty when native capture isn't available. */
  devices: AudioDeviceInfo[];
  apps: AudioAppInfo[];
  /** Development and tests: sessions play recorded files instead of capturing. */
  replay: boolean;
}

export type CaptureState = 'off' | 'starting' | 'ok' | 'recovering' | 'error';
export type SttState = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ChannelStatus {
  capture: CaptureState;
  stt: SttState;
  /** Device or app name, when known. */
  source: string | null;
  /** The latest problem on this channel, in plain English. */
  error: string | null;
}

export type LiveMode = 'interview' | 'test';
export type LiveStatus = 'starting' | 'live' | 'paused' | 'stopping' | 'ended' | 'failed';

export interface LiveState {
  /** Session ID; for audio tests a temporary ID (nothing is saved). */
  id: string;
  mode: LiveMode;
  title: string;
  status: LiveStatus;
  /** Epoch ms. */
  startedAt: number;
  /** Listening time (pauses excluded) as of `updatedAt`. */
  elapsedMs: number;
  updatedAt: number;
  backend: CaptureBackend;
  transcribing: boolean;
  channels: Record<AudioChannel, ChannelStatus>;
  /** The microphone seems to pick up the interviewer's audio (speakers, no headphones). */
  echoSuspected: boolean;
  /** Plain-English warnings, most important first. */
  warnings: string[];
  error: SerializedError | null;
}

export interface ChannelLevel {
  /** RMS level in dBFS over the last ~100 ms (−100 = silence). */
  db: number;
  speaking: boolean;
}

/** About 10 per second while live. */
export interface LiveMeter {
  id: string;
  levels: Record<AudioChannel, ChannelLevel>;
}

export interface TranscriptSegment {
  id: string;
  channel: AudioChannel;
  text: string;
  /** Milliseconds of listening time since the session started. */
  startMs: number;
  endMs: number;
}

export interface LiveTranscriptUpdate {
  id: string;
  /**
   * `interim`: the utterance so far; it replaces the previous interim text on
   * that channel. `final`: a finished segment; the channel's interim is cleared.
   */
  kind: 'interim' | 'final';
  segment: TranscriptSegment;
}

export interface LiveTranscript {
  id: string;
  segments: TranscriptSegment[];
  interim: Partial<Record<AudioChannel, TranscriptSegment>>;
}

// ── Live answers (Phase 4) ─────────────────────────────────────────────────

/** `bank`: an approved answer from the answer bank; `generated`: written live. */
export type AnswerSource = 'bank' | 'generated';

/**
 * What showed the answer:
 * - `question-mark`: the turn ended with "?" (shown at once; the analyzer can withdraw it);
 * - `analyzer`: the turn analyzer decided the interviewer finished a question;
 * - `fallback`: the analyzer decided after more than a second of silence;
 * - `manual`: "Answer now";
 * - `regenerate`: "Regenerate", "Shorter" or "Longer".
 */
export type AnswerTrigger = 'question-mark' | 'analyzer' | 'fallback' | 'manual' | 'regenerate';

/**
 * `streaming` → `done`, or `error`, or `stopped` (the interview ended or was
 * paused mid-answer). `withdrawn`: shown on the "?" fast path, then the
 * analyzer decided the interviewer wasn't finished, so it was taken back.
 */
export type LiveAnswerStatus = 'streaming' | 'done' | 'error' | 'stopped' | 'withdrawn';

export type AnswerLength = 'short' | 'standard' | 'detailed';

export interface LiveAnswer {
  /** The run (session) it belongs to. */
  runId: string;
  id: string;
  questionId: string;
  /** The question as the analyzer understood it (standalone), or what was heard. */
  question: string;
  /** The interviewer's words for this turn, as transcribed. */
  heard: string;
  /** Question type from the analyzer (behavioral, technical, …), when known. */
  type: string | null;
  source: AnswerSource;
  trigger: AnswerTrigger;
  length: AnswerLength;
  /** The model that wrote it; null for answer-bank answers. */
  model: string | null;
  /** For `bank`: the prepared answer shown. */
  preparedAnswerId: string | null;
  /** First line: an opening sentence; then bullets starting with "- ". */
  text: string;
  status: LiveAnswerStatus;
  error: string | null;
  /** The interviewer's last word → the first answer word on screen (ms). */
  latencyMs: number | null;
  /** Listening time (ms since the session started) when the interviewer stopped. */
  askedAtMs: number;
  createdAt: number;
  /** Background fact check of a generated answer; null when not checked. */
  check: AnswerCheck | null;
}

/** A statement in an answer that the profile and notes don't support. */
export interface AnswerIssue {
  /** Exact words from the answer. */
  quote: string;
  problem: string;
  /** What the sources say instead, if anything. */
  fix: string | null;
}

export interface AnswerCheck {
  status: 'checking' | 'ok' | 'issues' | 'error';
  issues: AnswerIssue[];
  model: string | null;
}

/** What the copilot is doing about the interviewer's current turn (for a subtle indicator). */
export type TurnPhase = 'idle' | 'listening' | 'thinking';

export interface LiveTurnUpdate {
  id: string;
  phase: TurnPhase;
}

export const LiveStartSchema = z.strictObject({
  mode: z.enum(['interview', 'test']),
  title: z.string().trim().max(120),
  profileId: z.string().max(64).nullable(),
  knowledgeBaseId: z.string().max(64).nullable(),
  /** Tests can skip transcription to check levels only. */
  transcribe: z.boolean(),
  /** Company and role being interviewed for; they help answers to "why us?" questions. */
  company: z.string().trim().max(120).default(''),
  role: z.string().trim().max(120).default(''),
});
/** Company and role may be left out (empty). */
export type LiveStartParams = z.input<typeof LiveStartSchema>;

export type SessionRecordStatus = 'live' | 'ended' | 'interrupted';

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionRecordStatus;
  profileName: string | null;
  knowledgeBaseName: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  segmentCount: number;
  /** Answers shown (Phase 4). */
  answerCount: number;
}

export interface SessionAudioInfo {
  backend: CaptureBackend;
  interviewer: string | null;
  candidate: string | null;
}

export interface SessionStats {
  /** Seconds of audio sent for transcription, per channel. */
  audioSeconds: Record<AudioChannel, number>;
  reconnects: number;
  /** Microphone segments dropped because they repeated the interviewer (echo). */
  echoDropped: number;
  /** Turn detection counters (Phase 4); absent on older sessions. */
  turns?: TurnStats;
  /** Model requests and tokens (Phase 5); absent on older sessions. */
  usage?: SessionUsage;
}

/** Live model requests for one model during a session. */
export interface ModelUsage {
  /** Requests sent, including duplicates (hedges), fallbacks and cancelled ones. */
  requests: number;
  /** Requests cancelled before they finished (the turn changed, a duplicate won). */
  cancelled: number;
  /** Reported by the provider. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Input tokens of requests that reported no usage (cancelled), estimated from the prompt. */
  estimatedInputTokens: number;
}

export interface SessionUsage {
  /** The transcription model used (priced per minute of audio sent). */
  transcriptionModel: string;
  /** Per model ID. */
  models: Record<string, ModelUsage>;
  /** Duplicate requests sent because the first was slow. */
  hedges: number;
  /** Requests answered by a fallback model after the first one failed. */
  failovers: number;
}

/** What a session cost on the user's key, estimated from published prices (USD). */
export interface SessionCost {
  /** null when the transcription model's price isn't known. */
  transcriptionUsd: number | null;
  modelsUsd: number;
  totalUsd: number;
  /** null for sessions under a minute. */
  perHourUsd: number | null;
  /** Models used whose prices aren't known (left out of the total). */
  unpriced: string[];
  /** When the prices were last checked (YYYY-MM-DD). */
  pricesChecked: string;
}

export interface TurnStats {
  /** Analyzer and answer requests started (each pause, transcript update or fallback). */
  attempts: number;
  /** Attempts cancelled: the interviewer kept talking or the analyzer said "wait". */
  cancelled: number;
  /** Questions answered (an answer was shown). */
  answered: number;
  /** Finished turns that needed no answer (statements, thanks, filler). */
  ignored: number;
  /** Answers shown on the "?" fast path and then taken back. */
  withdrawn: number;
}

/** A question and the answer shown for it, as saved with the session. */
export interface SessionAnswer {
  id: string;
  questionId: string;
  question: string;
  heard: string;
  type: string | null;
  source: AnswerSource;
  trigger: AnswerTrigger;
  length: AnswerLength;
  model: string | null;
  text: string;
  status: LiveAnswerStatus;
  latencyMs: number | null;
  askedAtMs: number;
  createdAt: number;
  check: AnswerCheck | null;
}

export interface SessionDetail extends SessionSummary {
  audio: SessionAudioInfo;
  stats: SessionStats | null;
  segments: TranscriptSegment[];
  /** Answers shown during the interview, oldest first (withdrawn ones excluded). */
  answers: SessionAnswer[];
  /** null for sessions from before Phase 5. */
  cost: SessionCost | null;
}

export const TranscriptFormatSchema = z.enum(['markdown', 'text']);
export type TranscriptFormat = z.infer<typeof TranscriptFormatSchema>;

// ── Hotkeys ────────────────────────────────────────────────────────────────

export const AcceleratorSchema = z
  .string()
  .max(64)
  .refine(isValidAccelerator, 'Use a modifier (Ctrl, Alt) plus a key, like Ctrl+Alt+Space.');
