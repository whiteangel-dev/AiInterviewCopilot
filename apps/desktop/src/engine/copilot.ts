import {
  TurnTaker,
  type AiProvider,
  type BankAnswer,
  type Logger,
  type TurnAnswer,
  type TurnLine,
  type TurnSegment,
  type TurnVerdict,
  type WriteResult,
} from '@aic/core';
import type { NewSessionAnswer, NewSessionQuestion } from '@aic/db';
import type { AnswerLength, LiveAnswer, LiveTurnUpdate, Settings, TurnStats } from '@aic/ipc';
import {
  LIVE_ANSWER_PROMPT_VERSION,
  TURN_ANALYZER_SYSTEM,
  TURN_VERDICT_SCHEMA,
  cleanAnswerText,
  formatHistory,
  liveAnswerInput,
  liveAnswerSystem,
  parseTurnVerdict,
  readTurnAction,
  turnAnalyzerInput,
} from '@aic/prompts';

/** History beyond this is cut from the front, in large steps so the prompt prefix stays cacheable. */
const MAX_HISTORY_CHARS = 24_000;
const HISTORY_KEEP = 0.6;
/** The analyzer sees only the last few lines before the turn. */
const ANALYZER_RECENT_LINES = 4;
const ANALYZER_RECENT_CHARS = 1200;

/** What a live run calls on the copilot (see LiveRun). */
export interface CopilotHooks {
  speech(who: 'interviewer' | 'candidate', speaking: boolean): void;
  interim(who: 'interviewer' | 'candidate', segment: TurnSegment): void;
  final(who: 'interviewer' | 'candidate', segment: TurnSegment): void;
  tick(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  readonly stats: TurnStats;
}

export interface CopilotOptions {
  runId: string;
  provider: AiProvider;
  apiKey: string;
  /** Snapshot at the start of the interview. */
  settings: Pick<Settings, 'models' | 'answers'>;
  /** The session context block (SESSION, CANDIDATE PROFILE, CANDIDATE KNOWLEDGE). */
  context: string;
  bank(heard: string): BankAnswer | null;
  /** Interviews save questions and answers; null for nothing. */
  save: {
    question(row: Omit<NewSessionQuestion, 'createdAt'>): void;
    answer(row: Omit<NewSessionAnswer, 'createdAt' | 'updatedAt'>): void;
  } | null;
  emit: {
    answer(answer: LiveAnswer): void;
    turn(update: LiveTurnUpdate): void;
  };
  log: Logger;
  now(): number;
  sessionMs(): number;
}

/**
 * Live answers for one interview: the turn taker (packages/core) wired to the
 * turn analyzer and answer writer (Gemini), the answer bank, the database and
 * the windows.
 */
export class LiveCopilot implements CopilotHooks {
  readonly turns: TurnTaker;
  readonly #systems = new Map<AnswerLength, string>();
  /** Lines cut from the front of the history (only ever moves forward). */
  #historyCut = 0;
  /** Question labels already saved, so repeated updates don't rewrite them. */
  readonly #savedQuestions = new Map<string, string>();

  constructor(private readonly o: CopilotOptions) {
    const { answers, models } = o.settings;
    const quality = answers.mode === 'quality';
    const answerModel = quality ? models.answerQuality : models.answerFast;
    this.turns = new TurnTaker({
      now: () => o.now(),
      sessionMs: () => o.sessionMs(),
      auto: answers.autoAnswer,
      length: answers.length,
      answerModel,
      analyze: (input, signal, onAction) => this.#analyze(input, signal, onAction),
      write: (input, signal, onText) =>
        this.#write(input.turn, input.history, input.length ?? answers.length, signal, onText),
      bank: (heard) => o.bank(heard),
      onAnswer: (answer, update) =>
        this.#onAnswer(answer, update.final, update.shown, update.usage),
      onPhase: (phase) => o.emit.turn({ id: o.runId, phase }),
      errorMessage: (err) => o.provider.toAppError(err).message,
      log: (message, data) => o.log.info(message, data),
    });
    // Open a connection now, so the first answer doesn't pay for it.
    void o.provider.warmUp(o.apiKey, answerModel);
  }

  get stats(): TurnStats {
    return { ...this.turns.stats };
  }

  speech(who: 'interviewer' | 'candidate', speaking: boolean): void {
    this.turns.speech(who, speaking);
  }
  interim(who: 'interviewer' | 'candidate', segment: TurnSegment): void {
    this.turns.interim(who, segment);
  }
  final(who: 'interviewer' | 'candidate', segment: TurnSegment): void {
    this.turns.final(who, segment);
  }
  tick(): void {
    this.turns.tick();
  }
  pause(): void {
    this.turns.pause();
  }
  resume(): void {
    this.turns.resume();
  }
  stop(): void {
    this.turns.stop();
  }

  answers(): LiveAnswer[] {
    return this.turns.answers().map((a) => ({ ...a, runId: this.o.runId }));
  }

  // ── Model calls ───────────────────────────────────────────────────────────

  async #analyze(
    input: { turn: string; history: readonly TurnLine[]; longSilence: boolean },
    signal: AbortSignal,
    onAction: (action: TurnVerdict['action']) => void,
  ): Promise<TurnVerdict | null> {
    const recent = formatHistory(input.history.slice(-ANALYZER_RECENT_LINES)).slice(
      -ANALYZER_RECENT_CHARS,
    );
    let json = '';
    const res = await this.o.provider.streamText({
      apiKey: this.o.apiKey,
      model: this.o.settings.models.turnAnalyzer,
      system: TURN_ANALYZER_SYSTEM,
      text: turnAnalyzerInput({ recent, turn: input.turn, longSilence: input.longSilence }),
      schema: TURN_VERDICT_SCHEMA,
      thinking: 'minimal',
      maxOutputTokens: 300,
      task: 'turn-analyzer',
      signal,
      onText: (piece) => {
        json += piece;
        const action = readTurnAction(json);
        if (action) onAction(action);
      },
    });
    return parseTurnVerdict(res.text);
  }

  async #write(
    turn: string,
    history: readonly TurnLine[],
    length: AnswerLength,
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<WriteResult> {
    const { answers, models } = this.o.settings;
    const quality = answers.mode === 'quality';
    let full = '';
    const res = await this.o.provider.streamText({
      apiKey: this.o.apiKey,
      model: quality ? models.answerQuality : models.answerFast,
      system: this.#system(length),
      text: liveAnswerInput({ history: formatHistory(this.#historyFor(history)), turn }),
      thinking: quality ? 'low' : 'minimal',
      maxOutputTokens: quality ? 4096 : 1024,
      task: 'live-answer',
      signal,
      onText: (piece) => {
        full += piece;
        const text = cleanAnswerText(full).trimStart();
        if (text) onText(text);
      },
    });
    if (!cleanAnswerText(res.text).trim()) throw new Error('The model returned an empty answer.');
    return {
      model: res.model,
      inputTokens: res.inputTokens,
      cachedTokens: res.cachedTokens,
      outputTokens: res.outputTokens,
      firstTextMs: res.firstTextMs,
      durationMs: res.durationMs,
    };
  }

  /** The static part of the prompt, built once per length. */
  #system(length: AnswerLength): string {
    let system = this.#systems.get(length);
    if (!system) {
      system = liveAnswerSystem({ length, context: this.o.context });
      this.#systems.set(length, system);
    }
    return system;
  }

  /**
   * The interview so far, append-only. When it grows past the limit, the
   * oldest lines are dropped in one large step, so most requests share the
   * same prefix (provider-side caching).
   */
  #historyFor(history: readonly TurnLine[]): readonly TurnLine[] {
    const size = (lines: readonly TurnLine[]) => lines.reduce((n, l) => n + l.text.length + 13, 0);
    if (history.length <= this.#historyCut) {
      // An older snapshot (regenerating an early answer): keep what fits.
      let start = 0;
      while (start < history.length && size(history.slice(start)) > MAX_HISTORY_CHARS) start++;
      return history.slice(start);
    }
    if (size(history.slice(this.#historyCut)) > MAX_HISTORY_CHARS) {
      while (
        this.#historyCut < history.length &&
        size(history.slice(this.#historyCut)) > MAX_HISTORY_CHARS * HISTORY_KEEP
      ) {
        this.#historyCut++;
      }
      this.o.log.info('interview history trimmed', { cut: this.#historyCut });
    }
    return history.slice(this.#historyCut);
  }

  // ── Answers out ───────────────────────────────────────────────────────────

  #onAnswer(answer: TurnAnswer, final: boolean, shown: boolean, usage: WriteResult | null) {
    this.o.emit.answer({ ...answer, runId: this.o.runId });
    const save = this.o.save;
    if (!save) return;
    try {
      const label = `${answer.question}\u0000${answer.type ?? ''}`;
      if (this.#savedQuestions.get(answer.questionId) !== label) {
        save.question({
          id: answer.questionId,
          sessionId: this.o.runId,
          heard: answer.heard,
          question: answer.question,
          type: answer.type,
          askedAtMs: answer.askedAtMs,
        });
        this.#savedQuestions.set(answer.questionId, label);
      }
      if (shown || final) {
        save.answer({
          id: answer.id,
          sessionId: this.o.runId,
          questionId: answer.questionId,
          source: answer.source,
          trigger: answer.trigger,
          length: answer.length,
          model: answer.model,
          preparedAnswerId: answer.preparedAnswerId,
          promptVersion: answer.source === 'generated' ? LIVE_ANSWER_PROMPT_VERSION : null,
          text: answer.text,
          status: answer.status,
          error: answer.error,
          latencyMs: answer.latencyMs,
          ...(usage
            ? {
                firstTextMs: usage.firstTextMs,
                durationMs: usage.durationMs,
                inputTokens: usage.inputTokens,
                cachedTokens: usage.cachedTokens,
                outputTokens: usage.outputTokens,
              }
            : {}),
        });
      }
    } catch (err) {
      this.o.log.error('saving an answer failed', { err });
    }
  }
}
