import { createHash } from 'node:crypto';
import {
  buildQuoteIndex,
  extractDocument,
  generateObject,
  isQuoteInDocument,
  type ContentPart,
  type ExtractedDocument,
} from '@aic/core';
import type { NewVersion, ProfileVersionRow } from '@aic/db';
import {
  AppError,
  countUnverified,
  type CandidateProfile,
  type EngineMethods,
  type ProfileDetail,
  type ProfileSummary,
  type ProfileVersionInfo,
  type RpcHandlers,
} from '@aic/ipc';
import {
  RESUME_PROMPT_VERSION,
  RESUME_USER_PROMPT,
  ResumeExtractionSchema,
  approxTokens,
  compileBrief,
  resumeExtractionSystem,
  toCandidateProfile,
} from '@aic/prompts';
import { PREPARATION_FALLBACK, type EngineContext } from './context';
import type { JobContext } from './jobs';

type ProfileMethods = Pick<
  RpcHandlers<EngineMethods>,
  | 'profiles.list'
  | 'profiles.get'
  | 'profiles.import'
  | 'profiles.reanalyze'
  | 'profiles.saveVersion'
  | 'profiles.restoreVersion'
  | 'profiles.rename'
  | 'profiles.delete'
  | 'profiles.resumeText'
>;

const versionInfo = (v: Omit<ProfileVersionRow, 'data' | 'brief'>): ProfileVersionInfo => ({
  id: v.id,
  version: v.version,
  origin: v.origin,
  createdAt: v.createdAt,
  model: v.model,
});

export function profileHandlers(ctx: EngineContext): ProfileMethods {
  const repo = () => ctx.ready().profiles;

  const detail = (id: string): ProfileDetail => {
    const r = repo();
    const profile = r.get(id);
    const current = profile && r.latestVersion(id);
    if (!profile || !current) throw new AppError('not_found', 'That profile no longer exists.');
    const doc = r.latestDocument(id);
    return {
      id: profile.id,
      name: profile.name,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      current: {
        ...versionInfo(current),
        data: current.data,
        brief: current.brief,
        briefTokens: approxTokens(current.brief),
      },
      document: doc
        ? {
            id: doc.id,
            fileName: doc.fileName,
            kind: doc.kind,
            sizeBytes: doc.sizeBytes,
            pageCount: doc.pageCount,
            textQuality: doc.textQuality,
            importedAt: doc.createdAt,
          }
        : null,
      versions: r.versions(id).map(versionInfo),
    };
  };

  /** Runs the model on a document and returns the reviewed-ready profile. */
  const analyze = async (
    job: JobContext,
    bytes: Uint8Array,
    doc: ExtractedDocument,
  ): Promise<{
    profile: CandidateProfile;
    stats: Omit<NewVersion, 'origin' | 'documentId' | 'data' | 'brief'>;
  }> => {
    const s = ctx.ready();
    const model = s.settings.models.preparation;
    const parts: ContentPart[] =
      doc.kind === 'pdf'
        ? [{ file: { mimeType: doc.mimeType, data: bytes } }, { text: RESUME_USER_PROMPT }]
        : [{ text: `RESUME\n${doc.text}` }, { text: RESUME_USER_PROMPT }];
    job.progress(
      'analyzing',
      `Reading your resume with ${model}. This usually takes 20–40 seconds.`,
    );
    const result = await generateObject(
      s.providers.gemini,
      {
        apiKey: ctx.requireKey('gemini'),
        model,
        system: resumeExtractionSystem(ctx.today()),
        parts,
        schema: ResumeExtractionSchema,
        task: 'resume_extraction',
        effort: 'low',
        signal: job.signal,
      },
      PREPARATION_FALLBACK,
    );
    job.progress('checking', 'Checking every statement against your resume…');
    const index = doc.textQuality === 'none' ? null : buildQuoteIndex(doc.text);
    const profile = toCandidateProfile(
      result.data,
      index ? (quote) => isQuoteInDocument(quote, index) : null,
    );
    ctx.log().info('resume analyzed', {
      model,
      ms: result.response.durationMs,
      attempts: result.attempts,
      inputTokens: result.response.inputTokens,
      outputTokens: result.response.outputTokens,
      unverified: countUnverified(profile),
      textQuality: doc.textQuality,
    });
    return {
      profile,
      stats: {
        model,
        promptVersion: RESUME_PROMPT_VERSION,
        durationMs: result.response.durationMs,
        inputTokens: result.response.inputTokens,
        outputTokens: result.response.outputTokens,
      },
    };
  };

  const fileStem = (fileName: string) =>
    fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim() || 'My resume';

  return {
    'profiles.list': (): ProfileSummary[] => {
      const r = repo();
      return r.list().flatMap((p) => {
        const v = r.latestVersion(p.id);
        if (!v) return [];
        const doc = r.latestDocument(p.id);
        return [
          {
            id: p.id,
            name: p.name,
            headline: v.data.headline,
            updatedAt: p.updatedAt,
            version: v.version,
            document: doc ? { fileName: doc.fileName, kind: doc.kind } : null,
            unverifiedCount: countUnverified(v.data),
          },
        ];
      });
    },

    'profiles.get': ({ id }) => detail(id),

    'profiles.import': ({ jobId, fileName, data, profileId }) =>
      ctx.jobs.run(jobId, async (job) => {
        if (profileId && !repo().get(profileId)) {
          throw new AppError('not_found', 'That profile no longer exists.');
        }
        ctx.requireKey('gemini');
        job.progress('reading', `Reading ${fileName}…`);
        const doc = await extractDocument(data, fileName);
        if (doc.kind === 'docx' && doc.textQuality === 'none') {
          throw new AppError('unsupported_file', `"${fileName}" doesn't contain any text.`);
        }
        const { profile, stats } = await analyze(job, data, doc);
        job.progress('saving', 'Saving…');

        const r = repo();
        const id = ctx.ready().db.db.transaction(() => {
          const target = profileId ?? r.create(profile.name || fileStem(fileName)).id;
          const document = r.addDocument(target, {
            fileName,
            kind: doc.kind,
            mimeType: doc.mimeType,
            sizeBytes: data.byteLength,
            sha256: createHash('sha256').update(data).digest('hex'),
            content: Buffer.from(data),
            text: doc.text,
            pageCount: doc.pageCount,
            textQuality: doc.textQuality,
          });
          r.addVersion(target, {
            ...stats,
            origin: 'extracted',
            documentId: document.id,
            data: profile,
            brief: compileBrief(profile),
          });
          return target;
        });
        return detail(id);
      }),

    'profiles.reanalyze': ({ jobId, id }) =>
      ctx.jobs.run(jobId, async (job) => {
        const r = repo();
        const meta = r.latestDocument(id);
        const stored = meta && r.document(meta.id);
        if (!stored) throw new AppError('not_found', 'This profile has no resume file to analyze.');
        ctx.requireKey('gemini');
        const bytes = new Uint8Array(stored.content);
        const doc: ExtractedDocument = {
          kind: stored.kind,
          mimeType: stored.mimeType,
          text: stored.text,
          pageCount: stored.pageCount,
          textQuality: stored.textQuality,
        };
        const { profile, stats } = await analyze(job, bytes, doc);
        r.addVersion(id, {
          ...stats,
          origin: 'extracted',
          documentId: stored.id,
          data: profile,
          brief: compileBrief(profile),
        });
        return detail(id);
      }),

    'profiles.saveVersion': ({ id, data }) => {
      const r = repo();
      if (!r.get(id)) throw new AppError('not_found', 'That profile no longer exists.');
      r.addVersion(id, {
        origin: 'edited',
        documentId: r.latestDocument(id)?.id ?? null,
        data,
        brief: compileBrief(data),
        model: null,
        promptVersion: null,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
      });
      return detail(id);
    },

    'profiles.restoreVersion': ({ id, versionId }) => {
      const r = repo();
      const old = r.version(id, versionId);
      if (!old) throw new AppError('not_found', 'That version no longer exists.');
      r.addVersion(id, {
        origin: 'restored',
        documentId: old.documentId,
        data: old.data,
        brief: compileBrief(old.data),
        model: null,
        promptVersion: null,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
      });
      return detail(id);
    },

    'profiles.rename': ({ id, name }) => {
      if (!repo().get(id)) throw new AppError('not_found', 'That profile no longer exists.');
      repo().rename(id, name);
      return detail(id);
    },

    'profiles.delete': ({ id }) => {
      repo().delete(id);
    },

    'profiles.resumeText': ({ id }) => {
      const r = repo();
      const meta = r.latestDocument(id);
      const doc = meta && r.document(meta.id);
      return doc ? { text: doc.text, textQuality: doc.textQuality } : null;
    },
  };
}
