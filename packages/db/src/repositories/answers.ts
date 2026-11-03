import type { PreparedAnswerFields } from '@aic/ipc';
import { asc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../open';
import { preparedAnswers, type PreparedAnswerRow } from '../schema';

export class AnswerRepository {
  constructor(private readonly db: Db) {}

  list(profileId: string): PreparedAnswerRow[] {
    return this.db
      .select()
      .from(preparedAnswers)
      .where(eq(preparedAnswers.profileId, profileId))
      .orderBy(asc(preparedAnswers.createdAt), asc(preparedAnswers.id))
      .all();
  }

  get(id: string): PreparedAnswerRow | undefined {
    return this.db.select().from(preparedAnswers).where(eq(preparedAnswers.id, id)).get();
  }

  add(
    profileId: string,
    answers: readonly (PreparedAnswerFields & {
      origin: 'generated' | 'manual';
      model: string | null;
    })[],
  ): PreparedAnswerRow[] {
    if (answers.length === 0) return [];
    const now = Date.now();
    return this.db
      .insert(preparedAnswers)
      .values(
        answers.map((a, i) => ({
          ...a,
          id: uuidv7(),
          profileId,
          createdAt: now + i,
          updatedAt: now,
        })),
      )
      .returning()
      .all();
  }

  update(id: string, fields: PreparedAnswerFields): PreparedAnswerRow | undefined {
    return this.db
      .update(preparedAnswers)
      .set({ ...fields, updatedAt: Date.now() })
      .where(eq(preparedAnswers.id, id))
      .returning()
      .get();
  }

  delete(id: string): boolean {
    return this.db.delete(preparedAnswers).where(eq(preparedAnswers.id, id)).run().changes > 0;
  }
}
