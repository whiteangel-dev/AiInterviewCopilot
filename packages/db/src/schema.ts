import type { KeyVerificationOutcome, ModelInfo } from '@aic/ipc';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type ProviderConfigRow = typeof providerConfigs.$inferSelect;
