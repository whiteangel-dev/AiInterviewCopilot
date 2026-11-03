import type { KnowledgeItemFields } from '@aic/ipc';
import { asc, count, desc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../open';
import {
  knowledgeAnalyses,
  knowledgeBases,
  knowledgeItems,
  type KnowledgeAnalysisRow,
  type KnowledgeBaseRow,
  type KnowledgeItemRow,
} from '../schema';

export class KnowledgeRepository {
  constructor(private readonly db: Db) {}

  listBases(): (KnowledgeBaseRow & { itemCount: number })[] {
    const counts = new Map(
      this.db
        .select({ baseId: knowledgeItems.baseId, n: count() })
        .from(knowledgeItems)
        .groupBy(knowledgeItems.baseId)
        .all()
        .map((r) => [r.baseId, r.n]),
    );
    return this.db
      .select()
      .from(knowledgeBases)
      .orderBy(desc(knowledgeBases.updatedAt))
      .all()
      .map((b) => ({ ...b, itemCount: counts.get(b.id) ?? 0 }));
  }

  getBase(id: string): KnowledgeBaseRow | undefined {
    return this.db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id)).get();
  }

  createBase(name: string, description = ''): KnowledgeBaseRow {
    const now = Date.now();
    return this.db
      .insert(knowledgeBases)
      .values({ id: uuidv7(), name, description, createdAt: now, updatedAt: now })
      .returning()
      .get();
  }

  updateBase(id: string, patch: { name?: string; description?: string }): void {
    this.db
      .update(knowledgeBases)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(knowledgeBases.id, id))
      .run();
  }

  deleteBase(id: string): boolean {
    return this.db.delete(knowledgeBases).where(eq(knowledgeBases.id, id)).run().changes > 0;
  }

  #touch(baseId: string, now: number): void {
    this.db
      .update(knowledgeBases)
      .set({ updatedAt: now })
      .where(eq(knowledgeBases.id, baseId))
      .run();
  }

  items(baseId: string): KnowledgeItemRow[] {
    return this.db
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.baseId, baseId))
      .orderBy(asc(knowledgeItems.createdAt), asc(knowledgeItems.id))
      .all();
  }

  item(id: string): KnowledgeItemRow | undefined {
    return this.db.select().from(knowledgeItems).where(eq(knowledgeItems.id, id)).get();
  }

  addItems(baseId: string, items: readonly KnowledgeItemFields[]): KnowledgeItemRow[] {
    if (items.length === 0) return [];
    return this.db.transaction((tx) => {
      const now = Date.now();
      const rows = items.map((fields, i) => ({
        ...fields,
        id: uuidv7(),
        baseId,
        // Keep insertion order stable even within the same millisecond.
        createdAt: now + i,
        updatedAt: now,
      }));
      const inserted = tx.insert(knowledgeItems).values(rows).returning().all();
      tx.update(knowledgeBases).set({ updatedAt: now }).where(eq(knowledgeBases.id, baseId)).run();
      return inserted;
    });
  }

  updateItem(id: string, fields: KnowledgeItemFields): KnowledgeItemRow | undefined {
    const now = Date.now();
    const row = this.db
      .update(knowledgeItems)
      .set({ ...fields, updatedAt: now })
      .where(eq(knowledgeItems.id, id))
      .returning()
      .get();
    if (row) this.#touch(row.baseId, now);
    return row;
  }

  deleteItem(id: string): boolean {
    const row = this.item(id);
    if (!row) return false;
    this.db.delete(knowledgeItems).where(eq(knowledgeItems.id, id)).run();
    this.#touch(row.baseId, Date.now());
    return true;
  }

  latestAnalysis(baseId: string): KnowledgeAnalysisRow | undefined {
    return this.db
      .select()
      .from(knowledgeAnalyses)
      .where(eq(knowledgeAnalyses.baseId, baseId))
      .orderBy(desc(knowledgeAnalyses.createdAt), desc(knowledgeAnalyses.id))
      .get();
  }

  saveAnalysis(row: Omit<KnowledgeAnalysisRow, 'id' | 'createdAt'>): KnowledgeAnalysisRow {
    return this.db.transaction((tx) => {
      // Only the latest analysis per base is useful; drop older ones.
      tx.delete(knowledgeAnalyses).where(eq(knowledgeAnalyses.baseId, row.baseId)).run();
      return tx
        .insert(knowledgeAnalyses)
        .values({ ...row, id: uuidv7(), createdAt: Date.now() })
        .returning()
        .get();
    });
  }
}
