import { AppError, type ModelInfo } from '@aic/ipc';
import type { AiProvider } from './types';

const model = (id: string, kind: ModelInfo['kind']): ModelInfo => ({
  id,
  displayName: id,
  kind,
  inputTokenLimit: kind === 'text' ? 1_048_576 : null,
  outputTokenLimit: kind === 'text' ? 65_536 : null,
});

export const FAKE_MODELS: ModelInfo[] = [
  model('gemini-3.8-flash', 'text'),
  model('gemini-3.5-transcribe-live', 'live'),
  model('gemini-3.5-flash-lite', 'text'),
  model('gemini-3.5-flash', 'text'),
  model('gemini-3.1-pro-preview', 'text'),
  model('gemini-3.1-flash-lite', 'text'),
  model('gemini-3.8-flash-tts', 'tts'),
];

/**
 * Offline stand-in for development and end-to-end tests. Keys containing
 * "INVALID" are rejected; keys containing "OFFLINE" fail like a network error.
 */
export class FakeProvider implements AiProvider {
  readonly id = 'gemini' as const;

  listModels(apiKey: string): Promise<ModelInfo[]> {
    if (apiKey.includes('INVALID')) {
      return Promise.reject(new AppError('invalid_api_key', 'Google rejected this API key.'));
    }
    if (apiKey.includes('OFFLINE')) {
      return Promise.reject(new AppError('network', "Couldn't reach Google."));
    }
    return Promise.resolve(structuredClone(FAKE_MODELS));
  }

  toAppError(err: unknown): AppError {
    return AppError.from(err);
  }
}
