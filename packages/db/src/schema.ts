import type {
  AnswerCategory,
  AnswerCheck,
  AnswerLength,
  AnswerSource,
  AnswerTrigger,
  AudioChannel,
  LiveAnswerStatus,
  SessionAudioInfo,
  SessionRecordStatus,
  SessionStats,
  CandidateProfile,
  DocumentKind,
  KeyVerificationOutcome,
  KnowledgeAnalysis,
  KnowledgeCategory,
  KnowledgeKind,
  ModelInfo,
  ProfileVersionOrigin,
  TextQuality,
} from '@aic/ipc';
import { blob, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Timestamps are epoch milliseconds. IDs are UUIDv7. */

/** One row per settings section; `value` is that section as JSON. */
export const appSettings = sqliteTable('app_settings', {
  section: text('section').primaryKey(),
  value: text('value', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * AI provider configuration. The API key itself lives in the OS-protected secret
 * store; `keyRef` names the entry and `keyHint` holds the last 4 characters.
 */
export const providerConfigs = sqliteTable('provider_configs', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().unique(),
  keyRef: text('key_ref'),
  keyHint: text('key_hint'),
  verification: text('verification')
    .$type<KeyVerificationOutcome>()
    .notNull()
    .default('unverified'),
  verificationMessage: text('verification_message'),
  checkedAt: integer('checked_at'),
  modelCatalog: text('model_catalog', { mode: 'json' }).$type<ModelInfo[]>(),
  modelsFetchedAt: integer('models_fetched_at'),
  /** Typed in, or imported from a key file (Phase 6). */
  keySource: text('key_source').$type<'typed' | 'file'>().notNull().default('typed'),
  keyLabel: text('key_label'),
  keyExpiresAt: integer('key_expires_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type ProviderConfigRow = typeof providerConfigs.$inferSelect;

// ── Profiles (Phase 2) ──────────────────────────────────────────────────────

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** The imported resume file (kept so it can be re-analyzed) and its extracted text. */
export const resumeDocuments = sqliteTable(
  'resume_documents',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    kind: text('kind').$type<DocumentKind>().notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    content: blob('content', { mode: 'buffer' }).notNull(),
    text: text('text').notNull(),
    pageCount: integer('page_count'),
    textQuality: text('text_quality').$type<TextQuality>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('resume_documents_profile_idx').on(t.profileId)],
);

/** Immutable. The highest version is the current profile. */
export const profileVersions = sqliteTable(
  'profile_versions',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    origin: text('origin').$type<ProfileVersionOrigin>().notNull(),
    documentId: text('document_id').references(() => resumeDocuments.id, { onDelete: 'set null' }),
    data: text('data', { mode: 'json' }).$type<CandidateProfile>().notNull(),
    brief: text('brief').notNull(),
    model: text('model'),
    promptVersion: text('prompt_version'),
    durationMs: integer('duration_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('profile_versions_profile_version_unique').on(t.profileId, t.version)],
);

// ── Application Knowledge (Phase 2) ─────────────────────────────────────────

export const knowledgeBases = sqliteTable('knowledge_bases', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const knowledgeItems = sqliteTable(
  'knowledge_items',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<KnowledgeKind>().notNull(),
    category: text('category').$type<KnowledgeCategory>().notNull(),
    title: text('title').notNull().default(''),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('knowledge_items_base_idx').on(t.baseId)],
);

export type StoredKnowledgeAnalysis = Pick<KnowledgeAnalysis, 'summary' | 'issues' | 'reclassify'>;

export const knowledgeAnalyses = sqliteTable(
  'knowledge_analyses',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    profileId: text('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    /** Hash of the items analyzed, to tell when the analysis is out of date. */
    itemsHash: text('items_hash').notNull(),
    result: text('result', { mode: 'json' }).$type<StoredKnowledgeAnalysis>().notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('knowledge_analyses_base_idx').on(t.baseId)],
);

// ── Answer bank (Phase 2) ───────────────────────────────────────────────────

export const preparedAnswers = sqliteTable(
  'prepared_answers',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    variants: text('variants', { mode: 'json' }).$type<string[]>().notNull(),
    category: text('category').$type<AnswerCategory>().notNull(),
    answer: text('answer').notNull(),
    status: text('status').$type<'draft' | 'approved'>().notNull(),
    origin: text('origin').$type<'generated' | 'manual'>().notNull(),
    model: text('model'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('prepared_answers_profile_idx').on(t.profileId)],
);

// ── Interview sessions (Phase 3) ────────────────────────────────────────────

/**
 * One interview. Keeps a snapshot of what it used (profile and knowledge base
 * names, the compiled answer context, the recognizer vocabulary), so it stays
 * meaningful after the profile changes or is deleted.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    status: text('status').$type<SessionRecordStatus>().notNull(),
    profileId: text('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    profileVersionId: text('profile_version_id').references(() => profileVersions.id, {
      onDelete: 'set null',
    }),
    profileName: text('profile_name'),
    knowledgeBaseId: text('knowledge_base_id').references(() => knowledgeBases.id, {
      onDelete: 'set null',
    }),
    knowledgeBaseName: text('knowledge_base_name'),
    context: text('context').notNull(),
    vocabulary: text('vocabulary', { mode: 'json' }).$type<string[]>().notNull(),
    audio: text('audio', { mode: 'json' }).$type<SessionAudioInfo>().notNull(),
    stats: text('stats', { mode: 'json' }).$type<SessionStats>(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    /** Listening time, pauses excluded. */
    durationMs: integer('duration_ms').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('sessions_started_idx').on(t.startedAt)],
);

/** Final transcript segments only (interim text is never stored). No audio is stored. */
export const transcriptSegments = sqliteTable(
  'transcript_segments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    channel: text('channel').$type<AudioChannel>().notNull(),
    text: text('text').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('transcript_segments_session_idx').on(t.sessionId, t.startMs)],
);

// ── Live answers (Phase 4) ──────────────────────────────────────────────────

/** A question the interviewer asked that got an answer (shown in the copilot). */
export const sessionQuestions = sqliteTable(
  'session_questions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The interviewer's words, as transcribed. */
    heard: text('heard').notNull(),
    /** The standalone question from the turn analyzer, or `heard`. */
    question: text('question').notNull(),
    type: text('type'),
    /** Listening time when the interviewer stopped. */
    askedAtMs: integer('asked_at_ms').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('session_questions_session_idx').on(t.sessionId, t.askedAtMs)],
);

/** An answer shown for a question (regenerating adds another). */
export const sessionAnswers = sqliteTable(
  'session_answers',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    questionId: text('question_id')
      .notNull()
      .references(() => sessionQuestions.id, { onDelete: 'cascade' }),
    source: text('source').$type<AnswerSource>().notNull(),
    trigger: text('trigger').$type<AnswerTrigger>().notNull(),
    length: text('length').$type<AnswerLength>().notNull(),
    model: text('model'),
    preparedAnswerId: text('prepared_answer_id').references(() => preparedAnswers.id, {
      onDelete: 'set null',
    }),
    promptVersion: text('prompt_version'),
    text: text('text').notNull(),
    status: text('status').$type<LiveAnswerStatus>().notNull(),
    error: text('error'),
    /** The interviewer's last word → first answer word on screen. */
    latencyMs: integer('latency_ms'),
    /** Request → first text from the model. */
    firstTextMs: integer('first_text_ms'),
    durationMs: integer('duration_ms'),
    inputTokens: integer('input_tokens'),
    cachedTokens: integer('cached_tokens'),
    outputTokens: integer('output_tokens'),
    /** Background fact check (Phase 5). */
    check: text('check', { mode: 'json' }).$type<AnswerCheck>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('session_answers_session_idx').on(t.sessionId, t.createdAt)],
);

export type ProfileRow = typeof profiles.$inferSelect;
export type ResumeDocumentRow = typeof resumeDocuments.$inferSelect;
export type ProfileVersionRow = typeof profileVersions.$inferSelect;
export type KnowledgeBaseRow = typeof knowledgeBases.$inferSelect;
export type KnowledgeItemRow = typeof knowledgeItems.$inferSelect;
export type KnowledgeAnalysisRow = typeof knowledgeAnalyses.$inferSelect;
export type PreparedAnswerRow = typeof preparedAnswers.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type TranscriptSegmentRow = typeof transcriptSegments.$inferSelect;
export type SessionQuestionRow = typeof sessionQuestions.$inferSelect;
export type NewSessionQuestion = typeof sessionQuestions.$inferInsert;
export type SessionAnswerRow = typeof sessionAnswers.$inferSelect;
export type NewSessionAnswer = typeof sessionAnswers.$inferInsert;
