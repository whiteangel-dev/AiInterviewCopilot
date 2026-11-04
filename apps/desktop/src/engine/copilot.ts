import {
  HedgeTimer,
  TurnTaker,
  UsageMeter,
  meteredProvider,
  streamHedged,
  type AiProvider,
  type HedgedResponse,
  type BankAnswer,
  type Logger,
  type TurnAnswer,
  type TurnLine,
  type TurnSegment,
  type TurnVerdict,
  type WriteResult,
} from '@aic/core';
import type { NewSessionAnswer, NewSessionQuestion } from '@aic/db';
import type {
  AnswerCheck,
  AnswerLength,
  LiveAnswer,
  LiveTurnUpdate,
  SessionUsage,
  Settings,
  TurnStats,
} from '@aic/ipc';
import {
  FACT_CHECK_SCHEMA,
  FACT_CHECK_SYSTEM,
  LIVE_ANSWER_PROMPT_VERSION,
  factCheckInput,
  parseFactCheck,
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
  readonly usage: SessionUsage;
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
    check(answerId: string, check: AnswerCheck): void;
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
  readonly #meter = new UsageMeter();
  /** The provider, with every request counted. */
  readonly #provider: AiProvider;
  /** When to send a duplicate request, learned from this session's response times. */
  readonly #analyzerHedge = new HedgeTimer();
  readonly #answerHedge = new HedgeTimer();
  #hedges = 0;
  #failovers = 0;
  /** The latest version of each answer, and its fact check. */
  readonly #latest = new Map<string, TurnAnswer>();
  readonly #checks = new Map<string, AnswerCheck>();

  constructor(private readonly o: CopilotOptions) {
    this.#provider = meteredProvider(o.provider, this.#meter);
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

  get usage(): SessionUsage {
    return {
      transcriptionModel: this.o.settings.models.transcription,
      models: this.#meter.snapshot(),
      hedges: this.#hedges,
      failovers: this.#failovers,
    };
  }

  /** Counts a hedged request's outcome, and learns from requests that weren't hedged. */
  #track(res: HedgedResponse, timer: HedgeTimer | null, what: string) {
    if (res.hedged) this.#hedges++;
    if (res.failedOver) {
      this.#failovers++;
      this.o.log.warn('live request answered by the backup model', { what, model: res.model });
    }
    if (!res.hedged && !res.failedOver) timer?.add(res.firstTextMs);
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
    return this.turns.answers().map((a) => this.#live(a));
  }

  #live(answer: TurnAnswer): LiveAnswer {
    const check = this.#checks.get(answer.id);
    return { ...answer, runId: this.o.runId, check: check ? structuredClone(check) : null };
  }

  // ── Fact check ────────────────────────────────────────────────────────────

  /**
   * Checks a finished generated answer against the profile and notes, off the
   * critical path. Unsupported statements are highlighted in the copilot.
   */
  async #factCheck(answer: TurnAnswer) {
    const model = this.o.settings.models.factCheck;
    this.#checks.set(answer.id, { status: 'checking', issues: [], model });
    this.o.emit.answer(this.#live(this.#latest.get(answer.id) ?? answer));
    let check: AnswerCheck;
    try {
      const res = await streamHedged(
        this.#provider,
        {
          apiKey: this.o.apiKey,
          model,
          system: FACT_CHECK_SYSTEM,
          text: factCheckInput({
            context: this.o.context,
            question: answer.question,
            answer: answer.text,
          }),
          schema: FACT_CHECK_SCHEMA,
          thinking: 'minimal',
          maxOutputTokens: 2048,
          task: 'fact-check',
        },
        { hedgeAfterMs: null, fallbackModels: [this.o.settings.models.liveBackup] },
      );
      this.#track(res, null, 'fact check');
      const issues = parseFactCheck(res.text, answer.text);
      check = issues
        ? { status: issues.length ? 'issues' : 'ok', issues, model: res.model }
        : { status: 'error', issues: [], model: res.model };
      if (issues?.length)
        this.o.log.info('fact check flagged an answer', { issues: issues.length });
    } catch (err) {
      this.o.log.warn('fact check failed', { err: this.o.provider.toAppError(err).message });
      check = { status: 'error', issues: [], model };
    }
    this.#checks.set(answer.id, check);
    this.o.emit.answer(this.#live(this.#latest.get(answer.id) ?? answer));
    try {
      this.o.save?.check(answer.id, check);
    } catch (err) {
      this.o.log.error('saving a fact check failed', { err });
    }
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
    const { models } = this.o.settings;
    const res = await streamHedged(
      this.#provider,
      {
        apiKey: this.o.apiKey,
        model: models.turnAnalyzer,
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
      },
      { hedgeAfterMs: this.#analyzerHedge.delayMs, fallbackModels: [models.liveBackup] },
    );
    this.#track(res, this.#analyzerHedge, 'turn analyzer');
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
    const res = await streamHedged(
      this.#provider,
      {
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
      },
      // Quality answers take ~5 s anyway: no duplicates, but fall back to Fast on failure.
      quality
        ? { hedgeAfterMs: null, fallbackModels: [models.answerFast, models.liveBackup] }
        : { hedgeAfterMs: this.#answerHedge.delayMs, fallbackModels: [models.liveBackup] },
    );
    this.#track(res, quality ? null : this.#answerHedge, 'answer');
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
    this.#latest.set(answer.id, answer);
    this.o.emit.answer(this.#live(answer));
    if (
      final &&
      answer.status === 'done' &&
      answer.source === 'generated' &&
      this.o.settings.answers.factCheck &&
      !this.#checks.has(answer.id)
    ) {
      void this.#factCheck(answer);
    }
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
