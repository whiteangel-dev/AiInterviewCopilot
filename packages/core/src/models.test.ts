import { DEFAULT_MODELS, type ModelInfo } from '@aic/ipc';
import { describe, expect, it } from 'vitest';
import { classifyGeminiModel, compareNewest, recommendModels } from './models';

const m = (id: string, kind: ModelInfo['kind'] = 'text'): ModelInfo => ({
  id,
  displayName: id,
  kind,
  inputTokenLimit: null,
  outputTokenLimit: null,
});

describe('models', () => {
  it('classifies Gemini models', () => {
    expect(classifyGeminiModel('gemini-3.5-transcribe-live', ['bidiGenerateContent'])).toBe('live');
    expect(classifyGeminiModel('gemini-3.8-flash-tts', ['generateContent'])).toBe('tts');
    expect(classifyGeminiModel('gemini-embedding-2', ['embedContent'])).toBe('embedding');
    expect(classifyGeminiModel('gemini-3.1-flash-image', ['generateContent'])).toBe('image');
    expect(classifyGeminiModel('deep-research-preview-04-2026', ['generateContent'])).toBe('other');
    expect(classifyGeminiModel('gemini-3.5-flash-lite', ['generateContent'])).toBe('text');
  });

  it('sorts newest first, stable before preview', () => {
    expect(
      ['gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-3.1-pro', 'gemini-3-flash'].sort(
        compareNewest,
      ),
    ).toEqual(['gemini-3.1-pro', 'gemini-3.1-pro-preview', 'gemini-3-flash', 'gemini-2.5-pro']);
  });

  it('prefers the measured defaults when available', () => {
    const models = [
      m('gemini-3.9-flash-lite'),
      m('gemini-3.5-flash-lite'),
      m('gemini-3.1-flash-lite'),
      m('gemini-3.1-pro-preview'),
      m('gemini-3.5-transcribe-live', 'live'),
    ];
    expect(recommendModels(models)).toEqual(DEFAULT_MODELS);
  });

  it('falls back to the newest model of the same family', () => {
    const models = [
      m('gemini-3.1-flash-lite'),
      m('gemini-2.5-flash-lite'),
      m('gemini-flash-lite-latest'),
      m('gemini-2.5-pro'),
      m('gemini-3.1-pro-preview-customtools'),
      m('gemini-3.5-transcribe', 'text'),
    ];
    expect(recommendModels(models)).toEqual({
      turnAnalyzer: 'gemini-3.1-flash-lite',
      answerFast: 'gemini-3.1-flash-lite',
      answerQuality: 'gemini-2.5-pro',
      // Not the same model as Fast answers.
      liveBackup: 'gemini-2.5-flash-lite',
      factCheck: 'gemini-3.1-flash-lite',
      preparation: 'gemini-2.5-pro',
    });
  });
});
