import { ApiError, GoogleGenAI, type Model } from '@google/genai';
import { AppError, type ModelInfo } from '@aic/ipc';
import { classifyGeminiModel, compareNewest } from '../models';
import { redact } from '../redact';
import { isNetworkError } from './errors';
import type { AiProvider } from './types';

const LIST_TIMEOUT_MS = 10_000;

export class GeminiProvider implements AiProvider {
  readonly id = 'gemini' as const;

  async listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: LIST_TIMEOUT_MS } });
    const pager = await ai.models.list({
      config: { pageSize: 1000, ...(signal ? { abortSignal: signal } : {}) },
    });
    const models: ModelInfo[] = [];
    for await (const model of pager as AsyncIterable<Model>) {
      const id = (model.name ?? '').replace(/^models\//, '');
      if (!id) continue;
      models.push({
        id,
        displayName: model.displayName ?? id,
        kind: classifyGeminiModel(id, model.supportedActions ?? []),
        inputTokenLimit: model.inputTokenLimit ?? null,
        outputTokenLimit: model.outputTokenLimit ?? null,
      });
    }
    return models.sort((a, b) => compareNewest(a.id, b.id));
  }

  toAppError(err: unknown): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof ApiError) {
      const detail = redact(err.message);
      if (
        err.status === 401 ||
        (err.status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(detail))
      ) {
        return new AppError(
          'invalid_api_key',
          'Google rejected this API key. Check that you copied the whole key and that it has not been deleted.',
        );
      }
      if (err.status === 403) {
        return new AppError(
          'invalid_api_key',
          "This key isn't allowed to use the Gemini API. Check the key's API restrictions in Google Cloud, or create a new key in Google AI Studio.",
        );
      }
      if (err.status === 429) {
        return new AppError(
          'quota',
          'This key has hit its rate limit or quota. Wait a minute and try again, or check your plan in Google AI Studio.',
        );
      }
      return new AppError(
        'provider_error',
        `Google's API returned an error (HTTP ${err.status}). Try again shortly.`,
        { cause: err },
      );
    }
    if (isNetworkError(err)) {
      return new AppError(
        'network',
        "Couldn't reach Google. Check your internet connection and try again.",
        { cause: err },
      );
    }
    return new AppError('internal', redact(err instanceof Error ? err.message : String(err)), {
      cause: err,
    });
  }
}
