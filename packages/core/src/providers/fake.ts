import { AppError, type ModelInfo } from '@aic/ipc';
import { fakeFactCheck, fakeLiveAnswer, fakeTurnVerdict, streamPieces } from './fake-live';
import { fakeStructuredReply } from './fake-responses';
import type {
  AiProvider,
  StructuredRequest,
  StructuredResponse,
  TextStreamRequest,
  TextStreamResponse,
} from './types';

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted) return abort();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

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

  /**
   * Live replies: a rule-based turn verdict, or a canned answer streamed a few
   * words at a time. The first piece arrives after `delayMs`.
   */
  async streamText(req: TextStreamRequest): Promise<TextStreamResponse> {
    if (req.apiKey.includes('INVALID'))
      throw new AppError('invalid_api_key', 'Google rejected this API key.');
    const started = performance.now();
    const text =
      req.task === 'turn-analyzer'
        ? fakeTurnVerdict(req.text)
        : req.task === 'fact-check'
          ? fakeFactCheck(req.text)
          : fakeLiveAnswer(req.text);
    const pieces = req.task === 'live-answer' ? streamPieces(text) : [text];
    let firstTextMs: number | null = null;
    await wait(this.delayMs, req.signal);
    for (const [i, piece] of pieces.entries()) {
      if (i > 0) await wait(Math.max(5, Math.round(this.delayMs / 3)), req.signal);
      firstTextMs ??= Math.round(performance.now() - started);
      req.onText?.(piece);
    }
    return {
      text,
      model: req.model,
      inputTokens: Math.ceil((req.system.length + req.text.length) / 4),
      cachedTokens: 0,
      outputTokens: Math.ceil(text.length / 4),
      firstTextMs,
      durationMs: Math.round(performance.now() - started),
      finishReason: 'STOP',
    };
  }

  warmUp(): Promise<void> {
    return Promise.resolve();
  }

  toAppError(err: unknown): AppError {
    if (err instanceof Error && err.name === 'AbortError') {
      return new AppError('cancelled', 'Cancelled.');
    }
    return AppError.from(err);
  }
}
