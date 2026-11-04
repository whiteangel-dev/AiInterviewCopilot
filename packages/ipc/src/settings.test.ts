import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  SettingsSchema,
  applySettingsPatch,
  parseStoredSettings,
} from './settings';

describe('settings', () => {
  it('defaults are valid', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back field by field when stored values are invalid or retired', () => {
    const settings = parseStoredSettings({
      appearance: { theme: 'neon' },
      answers: { mode: 'quality', length: 42, retiredField: true },
      models: 'not an object',
      unknownSection: { a: 1 },
    });
    expect(settings.appearance.theme).toBe('system');
    expect(settings.answers).toEqual({
      mode: 'quality',
      length: 'standard',
      autoAnswer: true,
      factCheck: true,
    });
    expect(settings.models).toEqual(DEFAULT_SETTINGS.models);
    expect(settings).not.toHaveProperty('unknownSection');
  });

  it('applies patches and reports only changed sections', () => {
    const { settings, changed } = applySettingsPatch(DEFAULT_SETTINGS, {
      appearance: { theme: 'dark' },
      answers: { mode: 'fast' },
    });
    expect(settings.appearance.theme).toBe('dark');
    expect(changed).toEqual(['appearance']);
    expect(DEFAULT_SETTINGS.appearance.theme).toBe('system');
  });

  it('rejects unknown fields, bad enum values and odd model IDs in patches', () => {
    expect(SettingsPatchSchema.safeParse({ appearance: { color: 'red' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ answers: { length: 'huge' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ models: { answerFast: '../etc' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ extra: {} }).success).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({ models: { answerFast: 'gemini-3.5-flash-lite' } }).success,
    ).toBe(true);
  });
});
