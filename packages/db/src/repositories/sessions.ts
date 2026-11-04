import type { AudioChannel, SessionAudioInfo, SessionStats } from '@aic/ipc';
import { and, asc, count, desc, eq, lt, max, ne } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../open';
import {
  sessionAnswers,
  sessionQuestions,
  sessions,
  transcriptSegments,
  type NewSession,
  type NewSessionAnswer,
  type NewSessionQuestion,
  type SessionAnswerRow,
  type SessionQuestionRow,
  type SessionRow,
  type TranscriptSegmentRow,
} from '../schema';

export type SessionListRow = SessionRow & { segmentCount: number; answerCount: number };

/** An answer with its question, oldest first. */
export type SessionAnswerWithQuestion = SessionAnswerRow & {
  question: Pick<SessionQuestionRow, 'heard' | 'question' | 'type' | 'askedAtMs'>;
};

export class SessionRepository {
  constructor(private readonly db: Db) {}

  create(fields: Omit<NewSession, 'id' | 'updatedAt' | 'status'>): SessionRow {
    return this.db
      .insert(sessions)
      .values({ ...fields, id: uuidv7(), status: 'live', updatedAt: Date.now() })
      .returning()
      .get();
  }

  get(id: string): SessionRow | undefined {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  /** Newest first, with segment and answer counts. */
  list(): SessionListRow[] {
    const counts = this.db
      .select({ sessionId: transcriptSegments.sessionId, n: count().as('n') })
      .from(transcriptSegments)
      .groupBy(transcriptSegments.sessionId)
      .as('counts');
    const answers = this.db
      .select({ sessionId: sessionAnswers.sessionId, a: count().as('a') })
      .from(sessionAnswers)
      .where(ne(sessionAnswers.status, 'withdrawn'))
      .groupBy(sessionAnswers.sessionId)
      .as('answer_counts');
    return this.db
      .select({ session: sessions, n: counts.n, a: answers.a })
      .from(sessions)
      .leftJoin(counts, eq(counts.sessionId, sessions.id))
      .leftJoin(answers, eq(answers.sessionId, sessions.id))
      .orderBy(desc(sessions.startedAt))
      .all()
      .map((r) => ({ ...r.session, segmentCount: r.n ?? 0, answerCount: r.a ?? 0 }));
  }

  answerCount(id: string): number {
    return (
      this.db
        .select({ n: count() })
        .from(sessionAnswers)
        .where(and(eq(sessionAnswers.sessionId, id), ne(sessionAnswers.status, 'withdrawn')))
        .get()?.n ?? 0
    );
  }

  /** Records a question, or updates its label (the analyzer's verdict can arrive later). */
  saveQuestion(fields: Omit<NewSessionQuestion, 'createdAt'>): void {
    this.db
      .insert(sessionQuestions)
      .values({ ...fields, createdAt: Date.now() })
      .onConflictDoUpdate({
        target: sessionQuestions.id,
        set: { question: fields.question, type: fields.type ?? null },
      })
      .run();
  }

  /** Records an answer when it's shown, and again when it finishes. */
  saveAnswer(fields: Omit<NewSessionAnswer, 'createdAt' | 'updatedAt'>): void {
    const now = Date.now();
    const { id: _id, sessionId: _s, questionId: _q, ...changes } = fields;
    this.db
      .insert(sessionAnswers)
      .values({ ...fields, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: sessionAnswers.id, set: { ...changes, updatedAt: now } })
      .run();
  }

  /** Answers with their questions, oldest first. Withdrawn answers are left out unless asked for. */
  answers(sessionId: string, { withdrawn = false } = {}): SessionAnswerWithQuestion[] {
    return this.db
      .select({ answer: sessionAnswers, question: sessionQuestions })
      .from(sessionAnswers)
      .innerJoin(sessionQuestions, eq(sessionQuestions.id, sessionAnswers.questionId))
      .where(
        withdrawn
          ? eq(sessionAnswers.sessionId, sessionId)
          : and(eq(sessionAnswers.sessionId, sessionId), ne(sessionAnswers.status, 'withdrawn')),
      )
      .orderBy(asc(sessionAnswers.createdAt), asc(sessionAnswers.id))
      .all()
      .map((r) => ({
        ...r.answer,
        question: {
          heard: r.question.heard,
          question: r.question.question,
          type: r.question.type,
          askedAtMs: r.question.askedAtMs,
        },
      }));
  }

  /** Answers still streaming when the app crashed or quit are marked stopped. */
  stopStreamingAnswers(): number {
    return this.db
      .update(sessionAnswers)
      .set({ status: 'stopped', updatedAt: Date.now() })
      .where(eq(sessionAnswers.status, 'streaming'))
      .run().changes;
  }

  segmentCount(id: string): number {
    return (
      this.db
        .select({ n: count() })
        .from(transcriptSegments)
        .where(eq(transcriptSegments.sessionId, id))
        .get()?.n ?? 0
    );
  }

  addSegment(
    sessionId: string,
    segment: { channel: AudioChannel; text: string; startMs: number; endMs: number },
  ): TranscriptSegmentRow {
    return this.db
      .insert(transcriptSegments)
      .values({ ...segment, id: uuidv7(), sessionId, createdAt: Date.now() })
      .returning()
      .get();
  }

  segments(sessionId: string): TranscriptSegmentRow[] {
    return this.db
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.sessionId, sessionId))
      .orderBy(asc(transcriptSegments.startMs), asc(transcriptSegments.id))
      .all();
  }

  update(
    id: string,
    patch: Partial<{
      title: string;
      status: SessionRow['status'];
      endedAt: number | null;
      durationMs: number;
      stats: SessionStats;
      audio: SessionAudioInfo;
    }>,
  ): SessionRow | undefined {
    return this.db
      .update(sessions)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(sessions.id, id))
      .returning()
      .get();
  }

  delete(id: string): boolean {
    return this.db.delete(sessions).where(eq(sessions.id, id)).run().changes > 0;
  }

  /**
   * Sessions still marked live when the engine starts were cut off by a crash
   * or a forced quit: mark them interrupted, ending at their last segment.
   */
  markInterrupted(): number {
    const live = this.db.select().from(sessions).where(eq(sessions.status, 'live')).all();
    for (const s of live) {
      const last = this.db
        .select({ at: max(transcriptSegments.createdAt), endMs: max(transcriptSegments.endMs) })
        .from(transcriptSegments)
        .where(eq(transcriptSegments.sessionId, s.id))
        .get();
      this.update(s.id, {
        status: 'interrupted',
        endedAt: last?.at ?? s.startedAt + s.durationMs,
        durationMs: Math.max(s.durationMs, last?.endMs ?? 0),
      });
    }
    return live.length;
  }

  /** Deletes finished sessions that started before `cutoff` (transcript retention). */
  purgeStartedBefore(cutoff: number): number {
    return this.db
      .delete(sessions)
      .where(and(lt(sessions.startedAt, cutoff), ne(sessions.status, 'live')))
      .run().changes;
  }
}
