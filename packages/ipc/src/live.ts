import { z } from 'zod';
import type { PreparedAnswer } from './answers';
import type { SerializedError } from './errors';
import { isValidAccelerator } from './hotkeys';

/**
 * Live listening (Phase 3): audio capture, live transcription, interview
 * sessions and their saved transcripts.
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

/** A prepared answer that matches what the interviewer just asked. */
export interface LiveSuggestion {
  id: string;
  /** The interviewer's words that matched. */
  heard: string;
  answer: PreparedAnswer;
  score: number;
  at: number;
}

export const LiveStartSchema = z.strictObject({
  mode: z.enum(['interview', 'test']),
  title: z.string().trim().max(120),
  profileId: z.string().max(64).nullable(),
  knowledgeBaseId: z.string().max(64).nullable(),
  /** Tests can skip transcription to check levels only. */
  transcribe: z.boolean(),
});
export type LiveStartParams = z.infer<typeof LiveStartSchema>;

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
}

export interface SessionDetail extends SessionSummary {
  audio: SessionAudioInfo;
  stats: SessionStats | null;
  segments: TranscriptSegment[];
}

export const TranscriptFormatSchema = z.enum(['markdown', 'text']);
export type TranscriptFormat = z.infer<typeof TranscriptFormatSchema>;

// ── Hotkeys ────────────────────────────────────────────────────────────────

export const AcceleratorSchema = z
  .string()
  .max(64)
  .refine(isValidAccelerator, 'Use a modifier (Ctrl, Alt) plus a key, like Ctrl+Alt+Space.');
