import type { AudioChannel, SessionAudioInfo, SessionStats } from '@aic/ipc';
import { and, asc, count, desc, eq, lt, max, ne } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../open';
import {
  sessions,
  transcriptSegments,
  type NewSession,
  type SessionRow,
  type TranscriptSegmentRow,
} from '../schema';

export type SessionListRow = SessionRow & { segmentCount: number };

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

  /** Newest first, with segment counts. */
  list(): SessionListRow[] {
    const counts = this.db
      .select({ sessionId: transcriptSegments.sessionId, n: count().as('n') })
      .from(transcriptSegments)
      .groupBy(transcriptSegments.sessionId)
      .as('counts');
    return this.db
      .select({ session: sessions, n: counts.n })
      .from(sessions)
      .leftJoin(counts, eq(counts.sessionId, sessions.id))
      .orderBy(desc(sessions.startedAt))
      .all()
      .map((r) => ({ ...r.session, segmentCount: r.n ?? 0 }));
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
