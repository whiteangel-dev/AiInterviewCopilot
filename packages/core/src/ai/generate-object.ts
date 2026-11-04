import { AppError } from '@aic/ipc';
import { z } from 'zod';
import { markModelUnavailable, usableModels } from '../providers/availability';
import type { AiProvider, StructuredRequest, StructuredResponse } from '../providers/types';

/**
 * JSON Schema for the model. Zod's output minus `$schema`, which the Gemini API
 * doesn't accept.
 */
export function toModelSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export interface GeneratedObject<T> {
  data: T;
  response: StructuredResponse;
  attempts: number;
}

/** Waits before retrying a temporary failure (server error, network). */
export const RETRY_DELAYS_MS = [1500, 4000];

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError('cancelled', 'Cancelled.'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new AppError('cancelled', 'Cancelled.'));
    });
  });
}

/**
 * Asks the provider for JSON matching `schema`, then parses and validates it.
 * Temporary failures (5xx, network) are retried with backoff; a malformed reply
 * (truncated, wrong shape) is retried once.
 */
export async function generateObject<S extends z.ZodType>(
  provider: AiProvider,
  request: Omit<StructuredRequest, 'schema'> & { schema: S },
  options: {
    retryDelaysMs?: readonly number[];
    /** Models to switch to if the key can't use `request.model` (e.g. a free key and Pro). */
    fallbackModels?: readonly string[];
  } = {},
): Promise<GeneratedObject<z.output<S>>> {
  const jsonSchema = toModelSchema(request.schema);
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const models = usableModels([request.model, ...(options.fallbackModels ?? [])]);
  let lastError = '';
  let transientRetries = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (request.signal?.aborted) throw new AppError('cancelled', 'Cancelled.');
    let response: StructuredResponse;
    const model = models[0]!;
    try {
      response = await provider.generateStructured({ ...request, model, schema: jsonSchema });
    } catch (err) {
      if (request.signal?.aborted) throw new AppError('cancelled', 'Cancelled.');
      const error = provider.toAppError(err);
      if (error.modelUnavailable && models.length > 1) {
        markModelUnavailable(model);
        models.shift();
        attempt--; // another model, not another try of the same reply
        continue;
      }
      const delay = delays[transientRetries];
      if (error.retryable && delay !== undefined) {
        transientRetries++;
        await sleep(delay, request.signal);
        attempt--; // a temporary failure doesn't use up a validation attempt
        continue;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      lastError = 'The reply was not valid JSON (it may have been cut off).';
      continue;
    }
    const result = request.schema.safeParse(parsed);
    if (result.success) return { data: result.data, response, attempts: attempt };
    lastError = z.prettifyError(result.error).slice(0, 400);
  }
  throw new AppError(
    'ai_output_invalid',
    `The AI model's reply didn't have the expected structure. Try again, or pick another model in Settings. (${lastError})`,
  );
}
