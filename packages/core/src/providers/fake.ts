import { AppError, type ModelInfo } from '@aic/ipc';
import { fakeStructuredReply } from './fake-responses';
import type { AiProvider, StructuredRequest, StructuredResponse } from './types';

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

  /** Replies after `delayMs` (default 50 ms), so progress and cancel paths run. */
  constructor(private readonly delayMs = Number(process.env.AIC_FAKE_DELAY_MS ?? 50)) {}

  async generateStructured(req: StructuredRequest): Promise<StructuredResponse> {
    if (req.apiKey.includes('INVALID'))
      throw new AppError('invalid_api_key', 'Google rejected this API key.');
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      req.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new AppError('cancelled', 'Cancelled.'));
      });
    });
    const input = req.parts.map((p) => ('text' in p ? p.text : '')).join('\n');
    const text = JSON.stringify(fakeStructuredReply(req.task, input));
    req.onProgress?.(text.length);
    return {
      text,
      model: req.model,
      inputTokens: Math.ceil(input.length / 4),
      outputTokens: Math.ceil(text.length / 4),
      durationMs: Date.now() - started,
    };
  }

  toAppError(err: unknown): AppError {
    return AppError.from(err);
  }
}
