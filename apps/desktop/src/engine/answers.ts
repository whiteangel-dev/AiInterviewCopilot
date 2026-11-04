import { generateObject, matchQuestion } from '@aic/core';
import type { PreparedAnswerRow } from '@aic/db';
import { AppError, type EngineMethods, type PreparedAnswer, type RpcHandlers } from '@aic/ipc';
import {
  AnswerBankSchema,
  answerBankInput,
  answerBankSystem,
  clip,
  compileKnowledge,
} from '@aic/prompts';
import { PREPARATION_FALLBACK, type EngineContext } from './context';

type AnswerMethods = Pick<
  RpcHandlers<EngineMethods>,
  | 'answers.list'
  | 'answers.generate'
  | 'answers.add'
  | 'answers.update'
  | 'answers.delete'
  | 'answers.match'
>;

/** Role-specific questions to add on each generation. */
const ROLE_SPECIFIC_COUNT = 6;
/** A generated question this similar to an existing one is a duplicate. */
const DUPLICATE_SCORE = 0.85;

export const toAnswer = (r: PreparedAnswerRow): PreparedAnswer => ({
  id: r.id,
  profileId: r.profileId,
  question: r.question,
  variants: r.variants,
  category: r.category,
  answer: r.answer,
  status: r.status,
  origin: r.origin,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export function answerHandlers(ctx: EngineContext): AnswerMethods {
  const repo = () => ctx.ready().answers;
  const requireProfile = (profileId: string) => {
    const version = ctx.ready().profiles.latestVersion(profileId);
    if (!version) throw new AppError('not_found', 'That profile no longer exists.');
    return version;
  };

  return {
    'answers.list': ({ profileId }) => repo().list(profileId).map(toAnswer),

    'answers.generate': ({ jobId, profileId, baseId }) =>
      ctx.jobs.run(jobId, async (job) => {
        const s = ctx.ready();
        const profile = requireProfile(profileId);
        const knowledge = baseId ? compileKnowledge(s.knowledge.items(baseId)) : '';
        const existing = repo().list(profileId);
        const model = s.settings.models.preparation;
        job.progress('writing', `Writing answers with ${model}. This can take up to a minute.`);
        const result = await generateObject(
          s.providers.gemini,
          {
            apiKey: ctx.requireKey('gemini'),
            model,
            system: answerBankSystem(s.settings.answers.length),
            parts: [
              {
                text: answerBankInput({
                  today: ctx.today(),
                  brief: profile.brief,
                  knowledge,
                  existing: existing.map((a) => a.question),
                  roleSpecificCount: ROLE_SPECIFIC_COUNT,
                }),
              },
            ],
            schema: AnswerBankSchema,
            task: 'answer_bank',
            effort: 'low',
            signal: job.signal,
          },
          PREPARATION_FALLBACK,
        );

        const accepted: typeof result.data.answers = [];
        for (const a of result.data.answers) {
          if (!a.question.trim() || !a.answer.trim()) continue;
          const pool = [...existing, ...accepted].map((x) => ({
            question: x.question,
            variants: x.variants,
          }));
          const [dup] = matchQuestion(a.question, pool, { limit: 1, minScore: DUPLICATE_SCORE });
          if (!dup) accepted.push(a);
        }
        repo().add(
          profileId,
          accepted.map((a) => ({
            question: clip(a.question, 400),
            variants: a.variants
              .map((v) => v.trim())
              .filter(Boolean)
              .slice(0, 10)
              .map((v) => clip(v, 400)),
            category: a.category,
            answer: clip(a.answer, 4000),
            status: 'draft' as const,
            origin: 'generated' as const,
            model,
          })),
        );
        ctx.log().info('answer bank generated', {
          returned: result.data.answers.length,
          added: accepted.length,
          ms: result.response.durationMs,
        });
        return repo().list(profileId).map(toAnswer);
      }),

    'answers.add': ({ profileId, fields }) => {
      requireProfile(profileId);
      const [row] = repo().add(profileId, [{ ...fields, origin: 'manual', model: null }]);
      return toAnswer(row!);
    },

    'answers.update': ({ id, fields }) => {
      const row = repo().update(id, fields);
      if (!row) throw new AppError('not_found', 'That answer no longer exists.');
      return toAnswer(row);
    },

    'answers.delete': ({ id }) => {
      repo().delete(id);
    },

    'answers.match': ({ profileId, question }) =>
      matchQuestion(question, repo().list(profileId).map(toAnswer)).map((m) => ({
        answer: m.item,
        score: m.score,
        matchedText: m.matchedText,
      })),
  };
}
