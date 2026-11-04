import type { AnswerLength } from '@aic/ipc';
import { GROUNDING_RULES, VOICE_RULES, formatRules } from './rules';

/**
 * Live answers (Phase 4): the turn analyzer, which decides whether the
 * interviewer has finished a question, and the answer writer. Both were
 * measured in Phase 0 (docs/phase0/results.md, §3 and §5).
 */

export const LIVE_ANSWER_PROMPT_VERSION = 'live-answer@2';
export const TURN_ANALYZER_PROMPT_VERSION = 'turn-analyzer@1';

export interface HistoryLine {
  who: 'interviewer' | 'candidate';
  text: string;
}

/** "Interviewer: …" / "Candidate: …", one line per turn (consecutive lines merged). */
export function formatHistory(lines: readonly HistoryLine[]): string {
  const merged: HistoryLine[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const last = merged.at(-1);
    if (last && last.who === line.who) last.text = `${last.text} ${text}`;
    else merged.push({ who: line.who, text });
  }
  return merged
    .map((l) => `${l.who === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${l.text}`)
    .join('\n');
}

// ── Answer writer ─────────────────────────────────────────────────────────────

const ANSWER_INTRO = `You are an interview copilot. The user is a job candidate in a live job interview. They glance at your text and say it in their own voice.
For the interviewer's latest turn, write what the candidate could say next, in first person, as the candidate.
The interview text comes from live speech recognition: expect small errors and missing punctuation, and read it charitably.`;

const LIVE_EXTRA = `CONVERSATION
- Answer only INTERVIEWER'S LATEST TURN. INTERVIEW SO FAR is context: never answer or acknowledge its questions again, even when no "Candidate:" line follows them (the candidate's replies aren't always transcribed).
- For follow-up questions, stay consistent with what the candidate already said (lines starting "Candidate:" in INTERVIEW SO FAR).
- Small talk: one or two friendly sentences, no bullets.
- If the latest turn doesn't ask the candidate anything (a statement, thanks, filler), write one short, natural sentence the candidate could say in reply, no bullets.
- If the latest turn holds several questions, answer the last one, and mention the others only if they belong together.`;

/**
 * The static part of the answer prompt: rules, then the session context
 * (SESSION, CANDIDATE PROFILE, CANDIDATE KNOWLEDGE). Byte-identical for every
 * request in a session at a given length, so provider-side caching can reuse it.
 */
export function liveAnswerSystem(opts: { length: AnswerLength; context: string }): string {
  return [
    ANSWER_INTRO,
    GROUNDING_RULES,
    VOICE_RULES,
    formatRules(opts.length),
    LIVE_EXTRA,
    opts.context.trim(),
  ].join('\n\n');
}

/** The per-request part: the interview so far (append-only), then the current turn. */
export function liveAnswerInput(opts: { history: string; turn: string }): string {
  return [
    `INTERVIEW SO FAR\n${opts.history.trim() || '(start of interview)'}`,
    `INTERVIEWER'S LATEST TURN\n${opts.turn.trim()}`,
  ].join('\n\n');
}

/**
 * Cleans a streamed answer for display: no surrounding quotes or labels the
 * model sometimes adds despite the rules. Safe to run on partial text.
 */
export function cleanAnswerText(text: string): string {
  return text
    .replace(/^\s*(?:answer|candidate|you)\s*:\s*/i, '')
    .replace(/^\s*["“]/, '')
    .replace(/\r\n/g, '\n')
    .replace(/^[*•]\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n');
}

// ── Turn analyzer ────────────────────────────────────────────────────────────

export const TURN_TYPES = [
  'small_talk',
  'background',
  'motivation',
  'behavioral',
  'technical',
  'system_design',
  'salary',
  'career',
  'closing',
  'statement',
  'filler',
  'other',
] as const;

export type TurnAction = 'answer' | 'ignore' | 'wait';

export interface TurnVerdict {
  complete: boolean;
  confidence: number;
  action: TurnAction;
  type: string;
  isFollowUp: boolean;
  standaloneQuestion: string;
}

export const TURN_ANALYZER_SYSTEM = `You analyze an interviewer's speech in a live job interview, in real time.
The interviewer has just paused. You get the recent conversation and the interviewer's CURRENT TURN transcript so far (from live speech recognition, so expect small errors).

Decide:
- complete: has the interviewer finished their turn and now expects the candidate to respond?
  Not complete if the transcript ends mid-phrase, with a trailing "and", "so", "um", "like", or a comma,
  or if it is only a lead-in ("Okay, so,", "Last question from me.", "So we use Go here.", "Interesting.") that usually precedes a question.
- confidence: 0 to 1, your confidence in "complete".
- action: "answer" if the turn asks the candidate something (a question, or a request like "tell me about…", "walk me through…");
  "ignore" if the finished turn needs no answer (thanks, a statement, filler); "wait" if not complete.
- type: ${TURN_TYPES.join(', ')}.
- isFollowUp: true if it builds on the previous question or the candidate's last answer.
- standaloneQuestion: the question rewritten to make sense without context (resolve "that", "it", "the incident"); empty unless action is "answer".`;

/** `action` is read from the stream as soon as it appears, before the rest of the JSON. */
export const TURN_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    confidence: { type: 'number' },
    action: { type: 'string', enum: ['answer', 'ignore', 'wait'] },
    type: { type: 'string' },
    isFollowUp: { type: 'boolean' },
    standaloneQuestion: { type: 'string' },
  },
  required: ['complete', 'confidence', 'action', 'type', 'isFollowUp', 'standaloneQuestion'],
  additionalProperties: false,
} as const;

export function turnAnalyzerInput(opts: {
  /** The last few lines before this turn (formatHistory). */
  recent: string;
  turn: string;
  /** Asked again after more than a second of silence. */
  longSilence: boolean;
}): string {
  const hint = opts.longSilence
    ? '\n\n(The interviewer has now been silent for over a second.)'
    : '';
  return `RECENT CONVERSATION\n${opts.recent.trim() || '(start of interview)'}\n\nCURRENT TURN SO FAR\n${opts.turn.trim()}${hint}`;
}

/** The action, as soon as the streamed JSON contains it. */
export function readTurnAction(partialJson: string): TurnAction | null {
  const m = /"action"\s*:\s*"(answer|ignore|wait)"/.exec(partialJson);
  return m ? (m[1] as TurnAction) : null;
}

/** Parses the full verdict leniently; null if the action can't be read. */
export function parseTurnVerdict(json: string): TurnVerdict | null {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    // A cut-off reply: fall back to what can be read.
  }
  const action =
    raw.action === 'answer' || raw.action === 'ignore' || raw.action === 'wait'
      ? raw.action
      : readTurnAction(json);
  if (!action) return null;
  return {
    complete: typeof raw.complete === 'boolean' ? raw.complete : action !== 'wait',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
    action,
    type: typeof raw.type === 'string' && raw.type ? raw.type : 'other',
    isFollowUp: raw.isFollowUp === true,
    standaloneQuestion:
      typeof raw.standaloneQuestion === 'string' ? raw.standaloneQuestion.trim() : '',
  };
}
