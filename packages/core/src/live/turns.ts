import { randomUUID } from 'node:crypto';
import type {
  AnswerLength,
  AnswerSource,
  AnswerTrigger,
  LiveAnswer,
  TurnPhase,
  TurnStats,
} from '@aic/ipc';

/**
 * Turn taking for live answers (Phase 4), as prototyped and measured in
 * Phase 0 (docs/phase0/results.md §1):
 *
 * - When the interviewer pauses (local voice detection, 300 ms), start an
 *   attempt: the turn analyzer ∥ a speculative answer.
 * - Re-run the attempt whenever the transcript grows during the pause (the
 *   last words usually arrive 0.5–0.8 s after speech ends).
 * - "?" fast path: a turn ending in "?" is shown as soon as the answer
 *   streams; the analyzer can still withdraw it.
 * - If the interviewer resumes, cancel the attempt.
 * - After 1.2 s of silence, ask the analyzer again with a hint.
 *
 * A turn is the interviewer's speech since the last boundary. A new turn
 * starts when the interviewer speaks after their previous turn was answered,
 * after the candidate spoke, or after a finished statement and a pause.
 * Otherwise more speech extends the current turn.
 *
 * No timers: the owner calls `tick()` about every 100 ms.
 */

export type TurnAction = 'answer' | 'ignore' | 'wait';

export interface TurnVerdict {
  complete: boolean;
  confidence: number;
  action: TurnAction;
  type: string;
  isFollowUp: boolean;
  standaloneQuestion: string;
}

export interface TurnLine {
  who: 'interviewer' | 'candidate';
  text: string;
}

export interface TurnSegment {
  id: string;
  text: string;
  /** Listening time when the utterance started (ms). */
  startMs: number;
}

export interface AnalyzeInput {
  turn: string;
  /** Final transcript lines before this turn, oldest first. */
  history: readonly TurnLine[];
  longSilence: boolean;
}

export interface WriteInput {
  turn: string;
  history: readonly TurnLine[];
  /** null: the length from settings. */
  length: AnswerLength | null;
}

export interface WriteResult {
  model: string;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  firstTextMs: number | null;
  durationMs: number;
}

export interface BankAnswer {
  preparedAnswerId: string;
  question: string;
  text: string;
}

/** An answer without the run ID (the owner adds it). */
export type TurnAnswer = Omit<LiveAnswer, 'runId'>;

export interface AnswerUpdate {
  /** Set once the answer has its final status. */
  final: boolean;
  /** Set on the first update of an answer (it was just shown). */
  shown: boolean;
  /** Writer usage, on the final update of a generated answer. */
  usage: WriteResult | null;
}

export interface TurnTakerOptions {
  /** Monotonic clock (ms). */
  now(): number;
  /** Listening time so far (ms), pauses excluded. */
  sessionMs(): number;
  /** Detect questions and answer them automatically; otherwise only on request. */
  auto: boolean;
  /** The answer length from settings (shown on answers). */
  length: AnswerLength;
  /** The model live answers use (shown on answers). */
  answerModel: string;
  /** Runs the turn analyzer. Calls `onAction` as soon as the action is known. */
  analyze(
    input: AnalyzeInput,
    signal: AbortSignal,
    onAction: (action: TurnAction) => void,
  ): Promise<TurnVerdict | null>;
  /** Writes an answer. `onText` gets the whole (cleaned) text so far. */
  write(
    input: WriteInput,
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<WriteResult>;
  /** An approved prepared answer that confidently matches what was heard. */
  bank(heard: string): BankAnswer | null;
  /** The whole answer each time it changes. */
  onAnswer(answer: TurnAnswer, update: AnswerUpdate): void;
  onPhase?(phase: TurnPhase): void;
  /** Turns an error from `write` into a message for the user. */
  errorMessage(err: unknown): string;
  log?(message: string, data?: Record<string, unknown>): void;
}

/** Voice detection reports a pause this long after the last word. */
export const PAUSE_MS = 300;
/** Ask the analyzer again once the silence reaches this. */
export const FALLBACK_SILENCE_MS = 1200;
/** Candidate speech (while the interviewer is silent) that ends the interviewer's turn. */
const CANDIDATE_TALK_MS = 1000;
/** A finished statement followed by a pause this long ends the turn. */
const STATEMENT_GAP_MS = 1500;
/** The turn text sent to the models is cut to its last ~this many characters. */
const MAX_TURN_CHARS = 1500;
/** Answers kept for regenerating. */
const KEEP_ANSWERS = 30;
/**
 * Stands in for the candidate's reply in the history when a question was
 * answered but nothing the candidate said was transcribed (microphone
 * transcription off, or missed). Without it, models answer the old question again.
 */
export const REPLY_NOT_TRANSCRIBED = '(answered; not transcribed)';

interface Turn {
  startMs: number;
  answered: boolean;
  ignored: boolean;
}

interface Draft {
  text: string;
  done: boolean;
  error: string | null;
  usage: WriteResult | null;
}

interface Attempt {
  n: number;
  text: string;
  history: TurnLine[];
  trigger: AnswerTrigger;
  /** Length override (regenerate). */
  length: AnswerLength | null;
  controller: AbortController;
  confirmed: boolean;
  verdict: TurnVerdict | null;
  bank: BankAnswer | null;
  draft: Draft;
  answer: TurnAnswer | null;
  questionId: string;
  question: string | null;
  type: string | null;
  /** The interviewer's last word: monotonic and listening time. */
  lastVoiceAt: number | null;
  askedAtMs: number;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The "?" fast path: a turn that ends with a question mark is shown without waiting. */
export function endsWithQuestion(text: string): boolean {
  return /\?["”')\]]*\s*$/.test(text);
}

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const sentence = cut.search(/[.?!]\s+\S/);
  return sentence >= 0 && sentence < max / 2 ? cut.slice(sentence + 1).trim() : cut.trim();
}

export class TurnTaker {
  readonly stats: TurnStats = { attempts: 0, cancelled: 0, answered: 0, ignored: 0, withdrawn: 0 };
  #lines: (TurnLine & { startMs: number; interviewer: boolean })[] = [];
  #interim: TurnSegment | null = null;
  #turn: Turn = { startMs: 0, answered: false, ignored: false };
  #open = false;
  #newTurnNext = false;
  #speaking = false;
  #pauseAt: number | null = null;
  #lastVoiceAt: number | null = null;
  #lastVoiceMs = 0;
  #fallbackDone = false;
  #candidateSince: number | null = null;
  #candidateTalkMs = 0;
  #attempt: Attempt | null = null;
  #lastAttemptText = '';
  #n = 0;
  #answers: Attempt[] = [];
  #regenerations = new Set<Attempt>();
  /** When each answered question ended (listening time), oldest first. */
  #answeredAt: number[] = [];
  #phase: TurnPhase = 'idle';
  #paused = false;
  #stopped = false;

  constructor(private readonly o: TurnTakerOptions) {}

  // ── Inputs ────────────────────────────────────────────────────────────────

  /** Voice activity changed on a channel (from local voice detection). */
  speech(who: 'interviewer' | 'candidate', speaking: boolean): void {
    if (this.#stopped || this.#paused) return;
    const now = this.o.now();
    if (who === 'candidate') {
      if (speaking && !this.#speaking) this.#candidateSince = now;
      if (!speaking) this.#endCandidateTalk(now);
      return;
    }
    this.#speaking = speaking;
    if (speaking) {
      this.#endCandidateTalk(now);
      this.#pauseAt = null;
      if (!this.#open || this.#turnEnded(now)) this.#openTurn();
      else this.#cancelAttempt('interviewer resumed');
      this.#candidateTalkMs = 0;
      this.#setPhase('listening');
    } else {
      this.#pauseAt = now;
      this.#lastVoiceAt = now - PAUSE_MS;
      this.#lastVoiceMs = Math.max(0, this.o.sessionMs() - PAUSE_MS);
      this.#fallbackDone = false;
      this.#setPhase('idle');
      if (this.o.auto) this.#startAttempt('pause');
    }
  }

  /** An utterance so far (empty text clears it). Only the interviewer's matter. */
  interim(who: 'interviewer' | 'candidate', segment: TurnSegment): void {
    if (this.#stopped || this.#paused || who !== 'interviewer') return;
    this.#interim = segment.text.trim() ? segment : null;
    if (this.#interim) this.#heard(segment.startMs);
    this.#onTranscriptChange();
  }

  /** A finished utterance on either channel (echo already removed). */
  final(who: 'interviewer' | 'candidate', segment: TurnSegment): void {
    if (this.#stopped) return;
    const text = segment.text.trim();
    if (who === 'interviewer') this.#interim = null;
    if (!text) return;
    this.#lines.push({ who, text, startMs: segment.startMs, interviewer: who === 'interviewer' });
    if (who === 'candidate' || this.#paused) return;
    this.#heard(segment.startMs);
    if (!this.#speaking && this.#pauseAt === null) {
      // Voice detection missed this speech (very quiet audio): treat the
      // transcript as the pause, which usually arrives ~0.7 s after the last word.
      const now = this.o.now();
      this.#pauseAt = now;
      this.#lastVoiceAt = now - 700;
      this.#lastVoiceMs = Math.max(0, this.o.sessionMs() - 700);
      this.#fallbackDone = false;
    }
    this.#onTranscriptChange();
  }

  /** About every 100 ms: the silence fallback. */
  tick(): void {
    if (this.#stopped || this.#paused || !this.o.auto || this.#pauseAt === null || this.#speaking)
      return;
    const silent = this.o.now() - this.#pauseAt + PAUSE_MS;
    if (
      silent >= FALLBACK_SILENCE_MS &&
      !this.#fallbackDone &&
      !this.#attempt &&
      !this.#turn.answered &&
      !this.#turn.ignored
    ) {
      if (this.#startAttempt('fallback')) this.#fallbackDone = true;
    }
  }

  /**
   * Listening paused: drop unconfirmed work. Transcript that still arrives is
   * kept as history; the next speech after `resume` starts a new turn.
   */
  pause(): void {
    this.#cancelAttempt('paused');
    this.#paused = true;
    this.#speaking = false;
    this.#pauseAt = null;
    this.#candidateSince = null;
    this.#candidateTalkMs = 0;
    this.#interim = null;
    this.#newTurnNext = true;
    this.#setPhase('idle');
  }

  resume(): void {
    this.#paused = false;
    this.#newTurnNext = true;
  }

  /** The run ended: stop everything; answers still streaming are marked stopped. */
  stop(): void {
    if (this.#stopped) return;
    this.#cancelAttempt('stopped');
    for (const a of [...this.#answers, ...this.#regenerations]) {
      if (a.answer && a.answer.status === 'streaming') {
        a.controller.abort();
        a.answer.status = 'stopped';
        this.#emit(a, { final: true, shown: false, usage: null });
      }
    }
    this.#regenerations.clear();
    this.#stopped = true;
    this.#setPhase('idle');
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  /**
   * "Answer now": answer the current turn at once. With nothing new to
   * answer, writes a fresh answer to the last question. Returns false if
   * there's nothing to answer.
   */
  answerNow(): boolean {
    if (this.#stopped) return false;
    const text = this.#turnText();
    if (text && !this.#turn.answered) {
      const a = this.#attempt;
      if (a && a.text === text && !a.answer) {
        a.confirmed = true;
        a.trigger = 'manual';
        this.#maybeShow(a);
        return true;
      }
      return this.#startAttempt('manual');
    }
    return this.regenerate(null, null);
  }

  /** A new answer to the same question as `answerId` (default: the latest). */
  regenerate(answerId: string | null, length: AnswerLength | null): boolean {
    if (this.#stopped) return false;
    const from = answerId
      ? this.#answers.find((a) => a.answer?.id === answerId)
      : this.#answers.at(-1);
    if (!from?.answer) return false;
    for (const r of this.#regenerations) this.#stopAnswer(r);
    this.#regenerations.clear();
    const a = this.#newAttempt({
      text: from.text,
      history: from.history,
      trigger: 'regenerate',
      length: length ?? from.length,
      bank: null,
    });
    a.confirmed = true;
    a.questionId = from.questionId;
    a.question = from.question;
    a.type = from.type;
    a.askedAtMs = from.askedAtMs;
    a.lastVoiceAt = null;
    this.#regenerations.add(a);
    this.#startWriter(a);
    return true;
  }

  /** Answers shown so far, oldest first. */
  answers(): TurnAnswer[] {
    return this.#answers.flatMap((a) => (a.answer ? [{ ...a.answer }] : []));
  }

  // ── Turns ─────────────────────────────────────────────────────────────────

  #endCandidateTalk(now: number) {
    if (this.#candidateSince !== null) {
      this.#candidateTalkMs += now - this.#candidateSince;
      this.#candidateSince = null;
    }
  }

  /** Whether speech starting now begins a new turn rather than extending this one. */
  #turnEnded(now: number): boolean {
    if (this.#newTurnNext || this.#turn.answered) return true;
    if (this.#candidateTalkMs >= CANDIDATE_TALK_MS) return true;
    return (
      this.#turn.ignored &&
      this.#lastVoiceAt !== null &&
      now - this.#lastVoiceAt >= STATEMENT_GAP_MS
    );
  }

  /**
   * Opens a new turn. Utterances that started from `startMs` on belong to it;
   * the default margin covers the voice detector's onset delay.
   */
  #openTurn(startMs = Math.max(0, this.o.sessionMs() - 100)) {
    if (this.#open && this.#turn.ignored && !this.#turn.answered) this.stats.ignored++;
    this.#cancelAttempt('new turn');
    this.#open = true;
    this.#newTurnNext = false;
    this.#lastAttemptText = '';
    this.#turn = { startMs, answered: false, ignored: false };
  }

  /** Transcribed interviewer speech with no turn open (voice detection missed it). */
  #heard(startMs: number) {
    if (!this.#open) this.#openTurn(startMs);
  }

  #inTurn(line: { interviewer: boolean; startMs: number }): boolean {
    return this.#open && line.interviewer && line.startMs >= this.#turn.startMs;
  }

  #turnText(): string {
    const parts = this.#lines.filter((l) => this.#inTurn(l)).map((l) => l.text);
    if (this.#interim && this.#interim.startMs >= this.#turn.startMs && this.#open) {
      parts.push(this.#interim.text.trim());
    }
    return tail(parts.join(' ').replace(/\s+/g, ' ').trim(), MAX_TURN_CHARS);
  }

  /**
   * Final lines before the current turn, oldest first. After an answered
   * question with no transcribed reply, a placeholder reply is added.
   */
  #history(): TurnLine[] {
    const out: TurnLine[] = [];
    let k = 0;
    const replied = (before: number) => {
      let due = false;
      while (k < this.#answeredAt.length && this.#answeredAt[k]! < before) {
        k++;
        due = true;
      }
      if (due && out.at(-1)?.who === 'interviewer') {
        out.push({ who: 'candidate', text: REPLY_NOT_TRANSCRIBED });
      }
    };
    for (const l of this.#lines) {
      if (this.#inTurn(l)) continue;
      if (l.interviewer) replied(l.startMs);
      out.push({ who: l.who, text: l.text });
    }
    replied(this.#open ? this.#turn.startMs : Number.POSITIVE_INFINITY);
    return out;
  }

  #onTranscriptChange() {
    if (this.o.auto && this.#pauseAt !== null && !this.#speaking) this.#startAttempt('update');
  }

  // ── Attempts ──────────────────────────────────────────────────────────────

  #newAttempt(fields: {
    text: string;
    history: TurnLine[];
    trigger: AnswerTrigger;
    length: AnswerLength | null;
    bank: BankAnswer | null;
  }): Attempt {
    return {
      n: ++this.#n,
      ...fields,
      controller: new AbortController(),
      confirmed: false,
      verdict: null,
      draft: { text: '', done: false, error: null, usage: null },
      answer: null,
      questionId: randomUUID(),
      question: null,
      type: null,
      lastVoiceAt: this.#lastVoiceAt,
      askedAtMs: this.#lastVoiceMs,
    };
  }

  /** Starts (or restarts) an attempt on the current turn. Returns false if nothing started. */
  #startAttempt(reason: 'pause' | 'update' | 'fallback' | 'manual'): boolean {
    const text = this.#turnText();
    if (!text || (this.#turn.answered && reason !== 'manual')) return false;
    const current = this.#attempt;
    if (reason !== 'manual') {
      if (current?.confirmed) return false;
      if (reason !== 'fallback' && text === this.#lastAttemptText) return false;
    }
    this.#cancelAttempt('superseded');
    this.#lastAttemptText = text;

    const trigger: AnswerTrigger =
      reason === 'manual' ? 'manual' : reason === 'fallback' ? 'fallback' : 'analyzer';
    const a = this.#newAttempt({
      text,
      history: this.#history(),
      trigger,
      length: null,
      bank: this.o.bank(text),
    });
    this.#attempt = a;
    this.stats.attempts++;
    if (reason === 'manual') {
      a.confirmed = true;
    } else if (endsWithQuestion(text)) {
      a.confirmed = true;
      a.trigger = 'question-mark';
    }
    this.#setPhase('thinking');
    this.o.log?.('turn attempt', {
      n: a.n,
      reason,
      words: words(text),
      bank: a.bank !== null,
      fastPath: a.trigger === 'question-mark',
    });

    if (a.bank) {
      a.draft = { text: a.bank.text, done: true, error: null, usage: null };
    } else {
      this.#startWriter(a);
    }
    if (reason !== 'manual') this.#startAnalyzer(a, reason === 'fallback');
    this.#maybeShow(a);
    return true;
  }

  #startAnalyzer(a: Attempt, longSilence: boolean) {
    let decided = false;
    this.o
      .analyze({ turn: a.text, history: a.history, longSilence }, a.controller.signal, (action) => {
        if (decided) return;
        decided = true;
        this.#decide(a, action);
      })
      .then((verdict) => {
        if (!verdict) {
          if (!decided && !a.controller.signal.aborted) this.#decide(a, 'wait');
          return;
        }
        a.verdict = verdict;
        if (!decided) {
          decided = true;
          this.#decide(a, verdict.action);
        }
        // The standalone question makes a better label than the raw transcript.
        if (verdict.action === 'answer') {
          a.type = verdict.type || null;
          if (verdict.standaloneQuestion) a.question = verdict.standaloneQuestion;
          if (a.answer && a.answer.status !== 'withdrawn') {
            a.answer.question = a.question ?? a.answer.question;
            a.answer.type = a.type;
            this.#emit(a, { final: false, shown: false, usage: null });
          }
        }
      })
      .catch((err: unknown) => {
        if (a.controller.signal.aborted) return;
        this.o.log?.('turn analyzer failed', { n: a.n, err: this.o.errorMessage(err) });
        // Without a verdict, a confirmed (fast-path) answer stays; otherwise wait
        // for the fallback or "Answer now".
        if (!decided) {
          decided = true;
          if (!a.confirmed) this.#decide(a, 'wait');
        }
      });
  }

  #startWriter(a: Attempt) {
    this.o
      .write(
        { turn: a.text, history: a.history, length: a.length },
        a.controller.signal,
        (text) => {
          if (a.controller.signal.aborted) return;
          a.draft.text = text;
          if (a.answer) {
            a.answer.text = text;
            this.#emit(a, { final: false, shown: false, usage: null });
          } else {
            this.#maybeShow(a);
          }
        },
      )
      .then((usage) => {
        if (a.controller.signal.aborted) return;
        a.draft.done = true;
        a.draft.usage = usage;
        if (a.answer) this.#finish(a, 'done', null);
        else this.#maybeShow(a);
      })
      .catch((err: unknown) => {
        if (a.controller.signal.aborted) return;
        const message = this.o.errorMessage(err);
        a.draft.done = true;
        a.draft.error = message;
        this.o.log?.('live answer failed', { n: a.n, err: message });
        if (a.answer) this.#finish(a, a.answer.text ? 'done' : 'error', message);
        else this.#maybeShow(a);
      });
  }

  #decide(a: Attempt, action: TurnAction) {
    if (a !== this.#attempt) return;
    if (action === 'answer') {
      if (!a.confirmed) {
        a.confirmed = true;
        if (a.trigger !== 'fallback') a.trigger = 'analyzer';
      }
      this.#maybeShow(a);
      return;
    }
    if (action === 'ignore') this.#turn.ignored = true;
    if (a.answer) {
      // Shown on the "?" fast path, but the interviewer isn't finished (or asked nothing).
      a.controller.abort();
      a.answer.status = 'withdrawn';
      this.#emit(a, { final: true, shown: false, usage: null });
      this.#answers = this.#answers.filter((x) => x !== a);
      this.#turn.answered = false;
      this.stats.answered--;
      this.stats.withdrawn++;
      this.#answeredAt = this.#answeredAt.filter((t) => t !== a.askedAtMs);
    } else {
      a.controller.abort();
      if (action === 'wait') this.stats.cancelled++;
    }
    this.#attempt = null;
    this.#setPhase(this.#speaking ? 'listening' : 'idle');
  }

  #cancelAttempt(why: string) {
    const a = this.#attempt;
    if (!a) return;
    this.#attempt = null;
    if (a.answer) return; // already shown: let it finish streaming
    a.controller.abort();
    this.stats.cancelled++;
    this.o.log?.('turn attempt cancelled', { n: a.n, why });
    this.#setPhase(this.#speaking ? 'listening' : 'idle');
  }

  /** Shows a confirmed attempt's answer once it has text (or failed). */
  #maybeShow(a: Attempt) {
    if (a.answer || !a.confirmed || this.#stopped) return;
    if (!a.draft.text && !a.draft.error) return;
    const now = this.o.now();
    const source: AnswerSource = a.bank ? 'bank' : 'generated';
    a.answer = {
      id: randomUUID(),
      questionId: a.questionId,
      question: a.question ?? a.verdict?.standaloneQuestion ?? a.text,
      heard: a.text,
      type: a.type ?? a.verdict?.type ?? null,
      source,
      trigger: a.trigger,
      length: a.length ?? this.o.length,
      model: source === 'bank' ? null : (a.draft.usage?.model ?? this.o.answerModel),
      preparedAnswerId: a.bank?.preparedAnswerId ?? null,
      text: a.draft.text,
      status: a.draft.error && !a.draft.text ? 'error' : a.draft.done ? 'done' : 'streaming',
      error: a.draft.text ? null : a.draft.error,
      latencyMs:
        a.lastVoiceAt !== null && a.trigger !== 'manual' && a.trigger !== 'regenerate'
          ? Math.max(0, Math.round(now - a.lastVoiceAt))
          : null,
      askedAtMs: a.askedAtMs,
      createdAt: Date.now(),
    };
    if (a.trigger !== 'regenerate') {
      this.#turn.answered = true;
      this.stats.answered++;
      this.#answeredAt.push(a.askedAtMs);
      this.#answeredAt.sort((x, y) => x - y);
    }
    this.#answers.push(a);
    if (this.#answers.length > KEEP_ANSWERS) this.#answers.shift();
    if (this.#attempt === a) this.#setPhase(this.#speaking ? 'listening' : 'idle');
    const final = a.answer.status !== 'streaming';
    if (final) this.#regenerations.delete(a);
    this.#emit(a, { final, shown: true, usage: final ? a.draft.usage : null });
  }

  #finish(a: Attempt, status: 'done' | 'error', error: string | null) {
    if (!a.answer || a.answer.status !== 'streaming') return;
    a.answer.status = status;
    a.answer.error = error;
    if (a.draft.usage) a.answer.model = a.draft.usage.model;
    this.#regenerations.delete(a);
    this.#emit(a, { final: true, shown: false, usage: a.draft.usage });
  }

  #stopAnswer(a: Attempt) {
    a.controller.abort();
    if (a.answer?.status === 'streaming') {
      a.answer.status = 'stopped';
      this.#emit(a, { final: true, shown: false, usage: null });
    }
  }

  #emit(a: Attempt, update: AnswerUpdate) {
    if (a.answer) this.o.onAnswer({ ...a.answer }, update);
  }

  #setPhase(phase: TurnPhase) {
    if (phase === this.#phase) return;
    this.#phase = phase;
    this.o.onPhase?.(phase);
  }
}
