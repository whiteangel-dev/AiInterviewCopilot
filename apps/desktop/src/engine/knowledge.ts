import { createHash } from 'node:crypto';
import { generateObject } from '@aic/core';
import type { KnowledgeAnalysisRow, KnowledgeItemRow } from '@aic/db';
import {
  AppError,
  type EngineMethods,
  type KnowledgeAnalysis,
  type KnowledgeBaseDetail,
  type KnowledgeItem,
  type KnowledgeItemFields,
  type RpcHandlers,
} from '@aic/ipc';
import {
  KNOWLEDGE_ANALYSIS_PROMPT_VERSION,
  KNOWLEDGE_ANALYSIS_SYSTEM,
  KNOWLEDGE_SPLIT_SYSTEM,
  KnowledgeAnalysisSchema,
  KnowledgeSplitSchema,
  buildSessionContext,
  clip,
  compileKnowledge,
  knowledgeAnalysisInput,
} from '@aic/prompts';
import { PREPARATION_FALLBACK, type EngineContext } from './context';

type KnowledgeMethods = Pick<
  RpcHandlers<EngineMethods>,
  | 'knowledge.listBases'
  | 'knowledge.getBase'
  | 'knowledge.createBase'
  | 'knowledge.updateBase'
  | 'knowledge.deleteBase'
  | 'knowledge.addItems'
  | 'knowledge.updateItem'
  | 'knowledge.deleteItem'
  | 'knowledge.analyze'
  | 'knowledge.splitNotes'
  | 'context.preview'
>;

const toItem = (r: KnowledgeItemRow): KnowledgeItem => ({
  id: r.id,
  baseId: r.baseId,
  kind: r.kind,
  category: r.category,
  title: r.title,
  content: r.content,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** Changes whenever an item is added, removed, or edited. */
export function itemsHash(items: readonly KnowledgeItemRow[]): string {
  const h = createHash('sha256');
  for (const i of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(JSON.stringify([i.id, i.kind, i.category, i.title, i.content]));
  }
  return h.digest('hex');
}

export function knowledgeHandlers(ctx: EngineContext): KnowledgeMethods {
  const repo = () => ctx.ready().knowledge;

  const toAnalysis = (
    row: KnowledgeAnalysisRow,
    items: readonly KnowledgeItemRow[],
  ): KnowledgeAnalysis => {
    const ids = new Set(items.map((i) => i.id));
    return {
      id: row.id,
      baseId: row.baseId,
      profileId: row.profileId,
      createdAt: row.createdAt,
      model: row.model,
      stale: row.itemsHash !== itemsHash(items),
      summary: row.result.summary,
      // Items deleted since the analysis drop out of its issues.
      issues: row.result.issues
        .map((i) => ({ ...i, itemIds: i.itemIds.filter((id) => ids.has(id)) }))
        .filter((i) => i.itemIds.length > 0 || i.involvesResume),
      reclassify: row.result.reclassify.filter((r) => {
        const item = items.find((i) => i.id === r.itemId);
        return item && (item.kind !== r.kind || item.category !== r.category);
      }),
    };
  };

  const detail = (id: string): KnowledgeBaseDetail => {
    const r = repo();
    const base = r.getBase(id);
    if (!base) throw new AppError('not_found', 'That knowledge base no longer exists.');
    const items = r.items(id);
    const analysis = r.latestAnalysis(id);
    return {
      id: base.id,
      name: base.name,
      description: base.description,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      items: items.map(toItem),
      analysis: analysis ? toAnalysis(analysis, items) : null,
    };
  };

  const latestBrief = (profileId: string | null): string | null => {
    if (!profileId) return null;
    const version = ctx.ready().profiles.latestVersion(profileId);
    if (!version) throw new AppError('not_found', 'That profile no longer exists.');
    return version.brief;
  };

  return {
    'knowledge.listBases': () =>
      repo()
        .listBases()
        .map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          itemCount: b.itemCount,
          updatedAt: b.updatedAt,
        })),

    'knowledge.getBase': ({ id }) => detail(id),

    'knowledge.createBase': ({ name, description }) =>
      detail(repo().createBase(name, description).id),

    'knowledge.updateBase': ({ id, name, description }) => {
      if (!repo().getBase(id))
        throw new AppError('not_found', 'That knowledge base no longer exists.');
      repo().updateBase(id, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return detail(id);
    },

    'knowledge.deleteBase': ({ id }) => {
      repo().deleteBase(id);
    },

    'knowledge.addItems': ({ baseId, items }) => {
      if (!repo().getBase(baseId))
        throw new AppError('not_found', 'That knowledge base no longer exists.');
      return repo().addItems(baseId, items).map(toItem);
    },

    'knowledge.updateItem': ({ id, fields }) => {
      const row = repo().updateItem(id, fields);
      if (!row) throw new AppError('not_found', 'That item no longer exists.');
      return toItem(row);
    },

    'knowledge.deleteItem': ({ id }) => {
      repo().deleteItem(id);
    },

    'knowledge.analyze': ({ jobId, baseId, profileId }) =>
      ctx.jobs.run(jobId, async (job) => {
        const s = ctx.ready();
        const items = repo().items(baseId);
        if (!repo().getBase(baseId))
          throw new AppError('not_found', 'That knowledge base no longer exists.');
        if (items.length === 0) throw new AppError('invalid_input', 'Add some notes first.');
        const brief = latestBrief(profileId);
        const refs = new Map(items.map((item, i) => [`k${i + 1}`, item]));
        const model = s.settings.models.preparation;
        job.progress('analyzing', `Reviewing ${items.length} notes with ${model}…`);
        const result = await generateObject(
          s.providers.gemini,
          {
            apiKey: ctx.requireKey('gemini'),
            model,
            system: KNOWLEDGE_ANALYSIS_SYSTEM,
            parts: [
              {
                text: knowledgeAnalysisInput(
                  [...refs].map(([ref, i]) => ({
                    ref,
                    kind: i.kind,
                    category: i.category,
                    title: i.title,
                    content: i.content,
                  })),
                  brief,
                ),
              },
            ],
            schema: KnowledgeAnalysisSchema,
            task: 'knowledge_analysis',
            effort: 'low',
            signal: job.signal,
          },
          PREPARATION_FALLBACK,
        );
        const idOf = (ref: string) => refs.get(ref.trim().replace(/^\[|\]$/g, ''))?.id;
        const issues = result.data.issues
          .map((issue) => ({
            type: issue.type,
            itemIds: [...new Set(issue.refs.map(idOf).filter((id): id is string => !!id))],
            involvesResume: issue.involvesResume && brief !== null,
            message: clip(issue.message, 400),
            suggestion: issue.suggestion?.trim() ? clip(issue.suggestion, 600) : null,
          }))
          .filter((i) => i.itemIds.length > 0 || i.involvesResume);
        const reclassify = result.data.reclassify.flatMap((r) => {
          const itemId = idOf(r.ref);
          return itemId ? [{ itemId, kind: r.kind, category: r.category }] : [];
        });
        const row = repo().saveAnalysis({
          baseId,
          profileId,
          itemsHash: itemsHash(items),
          result: { summary: clip(result.data.summary, 600), issues, reclassify },
          model,
          promptVersion: KNOWLEDGE_ANALYSIS_PROMPT_VERSION,
        });
        ctx.log().info('knowledge analyzed', {
          items: items.length,
          issues: issues.length,
          ms: result.response.durationMs,
        });
        return toAnalysis(row, items);
      }),

    'knowledge.splitNotes': ({ jobId, text }) =>
      ctx.jobs.run(jobId, async (job) => {
        const s = ctx.ready();
        const model = s.settings.models.preparation;
        job.progress('analyzing', `Organizing your notes with ${model}…`);
        const result = await generateObject(
          s.providers.gemini,
          {
            apiKey: ctx.requireKey('gemini'),
            model,
            system: KNOWLEDGE_SPLIT_SYSTEM,
            parts: [{ text: `NOTES\n${text}` }],
            schema: KnowledgeSplitSchema,
            task: 'knowledge_split',
            effort: 'low',
            signal: job.signal,
          },
          PREPARATION_FALLBACK,
        );
        return result.data.items
          .filter((i) => i.content.trim())
          .slice(0, 200)
          .map((i): KnowledgeItemFields => ({
            kind: i.kind,
            category: i.category,
            title: clip(i.title, 120),
            content: clip(i.content, 6000),
          }));
      }),

    'context.preview': ({ profileId, baseId }) => {
      const items = baseId ? repo().items(baseId) : [];
      return buildSessionContext({
        today: ctx.today(),
        brief: latestBrief(profileId),
        knowledge: compileKnowledge(items),
      });
    },
  };
}
