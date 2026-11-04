import { z } from 'zod';
import { PreparedAnswerFieldsSchema } from './answers';
import type { EventChannel, InvokeChannel } from './channels';
import type { EngineMethods } from './engine';
import { KnowledgeItemFieldsSchema } from './knowledge';
import type { HotkeyStatus } from './hotkeys';
import {
  LiveStartSchema,
  TranscriptFormatSchema,
  type LiveAnswer,
  type LiveMeter,
  type LiveState,
  type LiveTranscriptUpdate,
  type LiveTurnUpdate,
} from './live';
import { CandidateProfileSchema, type JobProgress } from './profile';
import { AnswerLengthSchema, SettingsPatchSchema, type Settings } from './settings';
import {
  ProviderIdSchema,
  type ApiKeyStatus,
  type AppInfo,
  type EngineStatus,
  type ModelCatalog,
  type UpdateStatus,
} from './types';

/** Hosts the renderer may ask the main process to open in the default browser. */
export const EXTERNAL_LINK_HOSTS = ['aistudio.google.com', 'ai.google.dev'] as const;

export const ApiKeySchema = z
  .string()
  .trim()
  .min(20, 'That key looks too short.')
  .max(256, 'That key looks too long.')
  .regex(/^[\x21-\x7e]+$/, 'API keys contain no spaces or special characters.');

export const ExternalUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' && (EXTERNAL_LINK_HOSTS as readonly string[]).includes(url.hostname)
  );
}, 'Link not allowed');

const NoInput = z.undefined();
const Provider = z.strictObject({ provider: ProviderIdSchema });
const Id = z.string().regex(/^[0-9a-f-]{8,64}$/i, 'Invalid ID');
const JobId = z.string().regex(/^[\w-]{8,64}$/, 'Invalid job ID');
const ById = z.strictObject({ id: Id });

/** Key files are a few hundred bytes. */
export const MAX_KEY_FILE_BYTES = 64 * 1024;

/** Resumes larger than this are rejected before they reach the engine. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** Renderer → main calls: input schemas (validated in main) and output types. */
export const invokeContract = {
  'app:getInfo': NoInput,
  'app:openPath': z.enum(['userData', 'logs']),
  'app:openExternal': ExternalUrlSchema,
  'app:deleteAllData': z.strictObject({ confirm: z.literal('DELETE') }),
  'app:updateStatus': NoInput,
  'app:checkForUpdates': NoInput,
  'app:installUpdate': NoInput,
  'engine:getStatus': NoInput,
  'settings:get': NoInput,
  'settings:update': SettingsPatchSchema,
  'apiKey:getStatus': Provider,
  'apiKey:save': z.strictObject({ provider: ProviderIdSchema, key: ApiKeySchema }),
  'apiKey:verify': Provider,
  'apiKey:remove': Provider,
  'apiKey:importFile': z.strictObject({
    provider: ProviderIdSchema,
    data: z
      .instanceof(Uint8Array)
      .refine((d) => d.byteLength > 0 && d.byteLength <= MAX_KEY_FILE_BYTES, 'Not a key file.'),
    password: z.string().min(1, 'Enter the password.').max(200),
  }),
  'apiKey:createFile': z.strictObject({
    provider: ProviderIdSchema,
    key: ApiKeySchema,
    password: z.string().min(8, 'Use a password of at least 8 characters.').max(200),
    label: z.string().trim().max(80),
    expiresAt: z.number().int().positive().nullable(),
  }),
  'models:list': z.strictObject({ provider: ProviderIdSchema, refresh: z.boolean() }),

  'jobs:cancel': z.strictObject({ jobId: JobId }),
  'profiles:list': NoInput,
  'profiles:get': ById,
  'profiles:import': z.strictObject({
    jobId: JobId,
    fileName: z.string().trim().min(1).max(255),
    data: z
      .instanceof(Uint8Array)
      .refine((d) => d.byteLength > 0, 'The file is empty.')
      .refine((d) => d.byteLength <= MAX_RESUME_BYTES, 'The file is larger than 10 MB.'),
    profileId: Id.nullable(),
  }),
  'profiles:reanalyze': z.strictObject({ jobId: JobId, id: Id }),
  'profiles:saveVersion': z.strictObject({ id: Id, data: CandidateProfileSchema }),
  'profiles:restoreVersion': z.strictObject({ id: Id, versionId: Id }),
  'profiles:rename': z.strictObject({ id: Id, name: z.string().trim().min(1).max(120) }),
  'profiles:delete': ById,
  'profiles:resumeText': ById,
  'knowledge:listBases': NoInput,
  'knowledge:getBase': ById,
  'knowledge:createBase': z.strictObject({
    name: z.string().trim().min(1, 'Name it first.').max(120),
    description: z.string().trim().max(500),
  }),
  'knowledge:updateBase': z.strictObject({
    id: Id,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
  }),
  'knowledge:deleteBase': ById,
  'knowledge:addItems': z.strictObject({
    baseId: Id,
    items: z.array(KnowledgeItemFieldsSchema).min(1).max(200),
  }),
  'knowledge:updateItem': z.strictObject({ id: Id, fields: KnowledgeItemFieldsSchema }),
  'knowledge:deleteItem': ById,
  'knowledge:analyze': z.strictObject({ jobId: JobId, baseId: Id, profileId: Id.nullable() }),
  'knowledge:splitNotes': z.strictObject({
    jobId: JobId,
    text: z.string().trim().min(1).max(30_000),
  }),
  'context:preview': z.strictObject({ profileId: Id.nullable(), baseId: Id.nullable() }),
  'answers:list': z.strictObject({ profileId: Id }),
  'answers:generate': z.strictObject({ jobId: JobId, profileId: Id, baseId: Id.nullable() }),
  'answers:add': z.strictObject({ profileId: Id, fields: PreparedAnswerFieldsSchema }),
  'answers:update': z.strictObject({ id: Id, fields: PreparedAnswerFieldsSchema }),
  'answers:delete': ById,
  'answers:match': z.strictObject({ profileId: Id, question: z.string().trim().min(1).max(1000) }),
  'audio:environment': z.strictObject({ refresh: z.boolean() }),
  'live:start': LiveStartSchema.extend({
    profileId: Id.nullable(),
    knowledgeBaseId: Id.nullable(),
  }),
  'live:pause': NoInput,
  'live:resume': NoInput,
  'live:stop': NoInput,
  'live:state': NoInput,
  'live:transcript': NoInput,
  'live:diagnostics': NoInput,
  'live:answers': NoInput,
  'live:answerNow': NoInput,
  'live:regenerate': z.strictObject({
    answerId: z.string().min(1).max(64).nullable(),
    length: AnswerLengthSchema.nullable(),
  }),
  'sessions:list': NoInput,
  'sessions:get': ById,
  'sessions:rename': z.strictObject({ id: Id, title: z.string().trim().min(1).max(120) }),
  'sessions:delete': ById,
  'sessions:saveTranscript': z.strictObject({
    id: Id,
    format: TranscriptFormatSchema,
    includeAnswers: z.boolean(),
  }),
  'app:copyText': z.string().max(500_000),
  'copilot:setVisible': z.strictObject({ visible: z.boolean() }),
  'copilot:getVisible': NoInput,
  'hotkeys:status': NoInput,
} satisfies Record<InvokeChannel, z.ZodType>;

/**
 * Channels that main forwards unchanged to an engine method. Their output type
 * is the engine method's result.
 */
export const FORWARDED_CHANNELS = {
  'jobs:cancel': 'jobs.cancel',
  'profiles:list': 'profiles.list',
  'profiles:get': 'profiles.get',
  'profiles:import': 'profiles.import',
  'profiles:reanalyze': 'profiles.reanalyze',
  'profiles:saveVersion': 'profiles.saveVersion',
  'profiles:restoreVersion': 'profiles.restoreVersion',
  'profiles:rename': 'profiles.rename',
  'profiles:delete': 'profiles.delete',
  'profiles:resumeText': 'profiles.resumeText',
  'knowledge:listBases': 'knowledge.listBases',
  'knowledge:getBase': 'knowledge.getBase',
  'knowledge:createBase': 'knowledge.createBase',
  'knowledge:updateBase': 'knowledge.updateBase',
  'knowledge:deleteBase': 'knowledge.deleteBase',
  'knowledge:addItems': 'knowledge.addItems',
  'knowledge:updateItem': 'knowledge.updateItem',
  'knowledge:deleteItem': 'knowledge.deleteItem',
  'knowledge:analyze': 'knowledge.analyze',
  'knowledge:splitNotes': 'knowledge.splitNotes',
  'context:preview': 'context.preview',
  'answers:list': 'answers.list',
  'answers:generate': 'answers.generate',
  'answers:add': 'answers.add',
  'answers:update': 'answers.update',
  'answers:delete': 'answers.delete',
  'answers:match': 'answers.match',
  'audio:environment': 'audio.environment',
  'live:start': 'live.start',
  'live:pause': 'live.pause',
  'live:resume': 'live.resume',
  'live:stop': 'live.stop',
  'live:state': 'live.state',
  'live:transcript': 'live.transcript',
  'live:diagnostics': 'live.diagnostics',
  'live:answers': 'live.answers',
  'live:answerNow': 'live.answerNow',
  'live:regenerate': 'live.regenerate',
  'sessions:list': 'sessions.list',
  'sessions:get': 'sessions.get',
  'sessions:rename': 'sessions.rename',
  'sessions:delete': 'sessions.delete',
} as const satisfies Partial<Record<InvokeChannel, keyof EngineMethods>>;

export type ForwardedChannel = keyof typeof FORWARDED_CHANNELS;

/** Forwarded channels that run AI jobs (minutes, not milliseconds). */
export const LONG_RUNNING_CHANNELS: ReadonlySet<InvokeChannel> = new Set([
  'profiles:import',
  'profiles:reanalyze',
  'knowledge:analyze',
  'knowledge:splitNotes',
  'answers:generate',
]);

type ForwardedOutputs = {
  [C in ForwardedChannel]: EngineMethods[(typeof FORWARDED_CHANNELS)[C]]['result'];
};

export interface InvokeOutputs extends ForwardedOutputs {
  'app:getInfo': AppInfo;
  'app:openPath': void;
  'app:openExternal': void;
  'app:deleteAllData': void;
  'app:updateStatus': UpdateStatus;
  'app:checkForUpdates': UpdateStatus;
  'app:installUpdate': void;
  'engine:getStatus': EngineStatus;
  'settings:get': Settings;
  'settings:update': Settings;
  'apiKey:getStatus': ApiKeyStatus;
  'apiKey:save': ApiKeyStatus;
  'apiKey:verify': ApiKeyStatus;
  'apiKey:remove': ApiKeyStatus;
  'apiKey:importFile': ApiKeyStatus;
  'apiKey:createFile': { saved: boolean };
  'models:list': ModelCatalog;
  'sessions:saveTranscript': { saved: boolean };
  'app:copyText': void;
  'copilot:setVisible': boolean;
  'copilot:getVisible': boolean;
  'hotkeys:status': HotkeyStatus[];
}

export type InvokeInput<C extends InvokeChannel> = z.input<(typeof invokeContract)[C]>;
export type InvokeOutput<C extends InvokeChannel> = InvokeOutputs[C];

/** Main → renderer events. */
export interface EventPayloads {
  'engine:status': EngineStatus;
  'settings:changed': Settings;
  'apiKey:changed': ApiKeyStatus;
  'job:progress': JobProgress;
  'live:state': LiveState | null;
  'live:meter': LiveMeter;
  'live:transcript': LiveTranscriptUpdate;
  'live:answer': LiveAnswer;
  'live:turn': LiveTurnUpdate;
  'copilot:visibility': boolean;
  'hotkeys:status': HotkeyStatus[];
  'app:update': UpdateStatus;
}

// Each forwarded channel's validated input must be what its engine method takes.
type ForwardedInputsMatch = {
  [C in ForwardedChannel]: z.output<
    (typeof invokeContract)[C]
  > extends EngineMethods[(typeof FORWARDED_CHANNELS)[C]]['params']
    ? true
    : C;
}[ForwardedChannel];
const _forwardedInputsMatch: ForwardedInputsMatch = true;
void _forwardedInputsMatch;

// Compile-time checks that the zod-free channel lists match the typed contract.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _schemasMatch: Exact<keyof typeof invokeContract, InvokeChannel> = true;
const _outputsMatch: Exact<keyof InvokeOutputs, InvokeChannel> = true;
const _eventsMatch: Exact<keyof EventPayloads, EventChannel> = true;
void [_schemasMatch, _outputsMatch, _eventsMatch];
