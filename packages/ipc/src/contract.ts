import { z } from 'zod';
import type { EventChannel, InvokeChannel } from './channels';
import { SettingsPatchSchema, type Settings } from './settings';
import {
  ProviderIdSchema,
  type ApiKeyStatus,
  type AppInfo,
  type EngineStatus,
  type ModelCatalog,
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

/** Renderer → main calls: input schemas (validated in main) and output types. */
export const invokeContract = {
  'app:getInfo': NoInput,
  'app:openPath': z.enum(['userData', 'logs']),
  'app:openExternal': ExternalUrlSchema,
  'app:deleteAllData': z.strictObject({ confirm: z.literal('DELETE') }),
  'engine:getStatus': NoInput,
  'settings:get': NoInput,
  'settings:update': SettingsPatchSchema,
  'apiKey:getStatus': Provider,
  'apiKey:save': z.strictObject({ provider: ProviderIdSchema, key: ApiKeySchema }),
  'apiKey:verify': Provider,
  'apiKey:remove': Provider,
  'models:list': z.strictObject({ provider: ProviderIdSchema, refresh: z.boolean() }),
} satisfies Record<InvokeChannel, z.ZodType>;

export interface InvokeOutputs {
  'app:getInfo': AppInfo;
  'app:openPath': void;
  'app:openExternal': void;
  'app:deleteAllData': void;
  'engine:getStatus': EngineStatus;
  'settings:get': Settings;
  'settings:update': Settings;
  'apiKey:getStatus': ApiKeyStatus;
  'apiKey:save': ApiKeyStatus;
  'apiKey:verify': ApiKeyStatus;
  'apiKey:remove': ApiKeyStatus;
  'models:list': ModelCatalog;
}

export type InvokeInput<C extends InvokeChannel> = z.input<(typeof invokeContract)[C]>;
export type InvokeOutput<C extends InvokeChannel> = InvokeOutputs[C];

/** Main → renderer events. */
export interface EventPayloads {
  'engine:status': EngineStatus;
  'settings:changed': Settings;
  'apiKey:changed': ApiKeyStatus;
}

// Compile-time checks that the zod-free channel lists match the typed contract.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _schemasMatch: Exact<keyof typeof invokeContract, InvokeChannel> = true;
const _outputsMatch: Exact<keyof InvokeOutputs, InvokeChannel> = true;
const _eventsMatch: Exact<keyof EventPayloads, EventChannel> = true;
void [_schemasMatch, _outputsMatch, _eventsMatch];
