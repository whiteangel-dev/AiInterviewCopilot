import { z } from 'zod';
import { DEFAULT_MODELS } from './models';

/**
 * User settings. Stored per section in SQLite (`app_settings`), read leniently
 * (an invalid or retired value falls back to its default, field by field), and
 * changed only through validated patches.
 */

export const ModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'Not a valid model ID');

export const ThemeSchema = z.enum(['system', 'light', 'dark']);
export const AnswerModeSchema = z.enum(['fast', 'quality']);
export const AnswerLengthSchema = z.enum(['short', 'standard', 'detailed']);
export const TranscriptRetentionSchema = z.enum(['7d', '30d', '90d', '1y', 'forever']);

const fields = {
  appearance: {
    theme: ThemeSchema,
  },
  models: {
    transcription: ModelIdSchema,
    turnAnalyzer: ModelIdSchema,
    answerFast: ModelIdSchema,
    answerQuality: ModelIdSchema,
    preparation: ModelIdSchema,
  },
  answers: {
    mode: AnswerModeSchema,
    length: AnswerLengthSchema,
  },
  privacy: {
    transcriptRetention: TranscriptRetentionSchema,
  },
} as const;

export const SettingsSchema = z.strictObject({
  appearance: z.strictObject(fields.appearance),
  models: z.strictObject(fields.models),
  answers: z.strictObject(fields.answers),
  privacy: z.strictObject(fields.privacy),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsSection = keyof Settings;
export type ModelRoles = Settings['models'];
export type Theme = z.infer<typeof ThemeSchema>;

export const SETTINGS_SECTIONS = Object.keys(fields) as SettingsSection[];

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: 'system' },
  models: { ...DEFAULT_MODELS },
  answers: { mode: 'fast', length: 'standard' },
  privacy: { transcriptRetention: '90d' },
};

export const SettingsPatchSchema = z.strictObject({
  appearance: z.strictObject(fields.appearance).partial().optional(),
  models: z.strictObject(fields.models).partial().optional(),
  answers: z.strictObject(fields.answers).partial().optional(),
  privacy: z.strictObject(fields.privacy).partial().optional(),
});

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/**
 * Builds settings from stored sections. Unknown sections and fields are dropped;
 * each missing or invalid field falls back to its default, so one bad value never
 * resets the rest.
 */
export function parseStoredSettings(stored: Partial<Record<string, unknown>>): Settings {
  const result = structuredClone(DEFAULT_SETTINGS);
  for (const section of SETTINGS_SECTIONS) {
    const raw = stored[section];
    if (typeof raw !== 'object' || raw === null) continue;
    const target = result[section] as Record<string, unknown>;
    const shape = fields[section] as Record<string, z.ZodType>;
    for (const [field, schema] of Object.entries(shape)) {
      const parsed = schema.safeParse((raw as Record<string, unknown>)[field]);
      if (parsed.success) target[field] = parsed.data;
    }
  }
  return result;
}

/** Applies a validated patch. Returns the new settings and the sections that changed. */
export function applySettingsPatch(
  current: Settings,
  patch: SettingsPatch,
): { settings: Settings; changed: SettingsSection[] } {
  const settings = structuredClone(current);
  const changed: SettingsSection[] = [];
  for (const section of SETTINGS_SECTIONS) {
    const sectionPatch = patch[section];
    if (!sectionPatch) continue;
    const target = settings[section] as Record<string, unknown>;
    let sectionChanged = false;
    for (const [field, value] of Object.entries(sectionPatch)) {
      if (value === undefined || target[field] === value) continue;
      target[field] = value;
      sectionChanged = true;
    }
    if (sectionChanged) changed.push(section);
  }
  return { settings, changed };
}
