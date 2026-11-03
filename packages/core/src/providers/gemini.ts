import {
  ApiError,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentConfig,
  type Model,
  type Part,
} from '@google/genai';
import { AppError, type ModelInfo } from '@aic/ipc';
import { classifyGeminiModel, compareNewest } from '../models';
import { redact } from '../redact';
import { isNetworkError } from './errors';
import type { AiProvider, StructuredRequest, StructuredResponse } from './types';

const LIST_TIMEOUT_MS = 10_000;
const GENERATE_TIMEOUT_MS = 300_000;

/** Models that rejected a thinking setting; they are asked without one from then on. */
const noThinkingConfig = new Set<string>();

function toPart(part: StructuredRequest['parts'][number]): Part {
  if ('text' in part) return { text: part.text };
  return {
    inlineData: {
      mimeType: part.file.mimeType,
      data: Buffer.from(part.file.data).toString('base64'),
    },
  };
}

function isThinkingConfigError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && /thinking|budget/i.test(err.message);
}

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

  async generateStructured(req: StructuredRequest): Promise<StructuredResponse> {
    const ai = new GoogleGenAI({
      apiKey: req.apiKey,
      httpOptions: { timeout: GENERATE_TIMEOUT_MS },
    });
    const started = Date.now();
    const useThinking = req.effort === 'low' && !noThinkingConfig.has(req.model);
    const config: GenerateContentConfig = {
      systemInstruction: req.system,
      responseMimeType: 'application/json',
      responseJsonSchema: req.schema,
      ...(req.signal ? { abortSignal: req.signal } : {}),
      ...(useThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
    };
    const contents = [{ role: 'user', parts: req.parts.map(toPart) }];

    let stream;
    try {
      stream = await ai.models.generateContentStream({ model: req.model, contents, config });
    } catch (err) {
      if (useThinking && isThinkingConfigError(err)) {
        noThinkingConfig.add(req.model);
        return this.generateStructured(req);
      }
      throw err;
    }

    let text = '';
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let finishReason: string | undefined;
    for await (const chunk of stream) {
      const piece = chunk.text;
      if (piece) {
        text += piece;
        req.onProgress?.(text.length);
      }
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
      }
      finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
    }
    if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
      throw new AppError('provider_error', 'Google declined to process this content.');
    }
    return { text, model: req.model, inputTokens, outputTokens, durationMs: Date.now() - started };
  }

  toAppError(err: unknown): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
      return new AppError('cancelled', 'Cancelled.');
    }
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
      if (err.status === 404) {
        return new AppError(
          'provider_error',
          "The selected model isn't available to this key. Choose another one in Settings → Models.",
          { cause: err },
        );
      }
      if (err.status === 400) {
        return new AppError(
          'provider_error',
          `Google rejected the request: ${detail.slice(0, 200)}`,
          {
            cause: err,
          },
        );
      }
      return new AppError(
        'provider_error',
        `Google's API returned an error (HTTP ${err.status}). Try again shortly.`,
        { cause: err, retryable: err.status >= 500 },
      );
    }
    if (isNetworkError(err)) {
      return new AppError(
        'network',
        "Couldn't reach Google. Check your internet connection and try again.",
        { cause: err, retryable: true },
      );
    }
    return new AppError('internal', redact(err instanceof Error ? err.message : String(err)), {
      cause: err,
    });
  }
}
