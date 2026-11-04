import type { ModelUsage } from '@aic/ipc';
import type { AiProvider, TextStreamRequest } from './types';

/** Gemini text is about 4 characters per token (used only when usage isn't reported). */
const CHARS_PER_TOKEN = 4;

const empty = (): ModelUsage => ({
  requests: 0,
  cancelled: 0,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  estimatedInputTokens: 0,
});

/**
 * Counts live requests and tokens per model. Cancelled requests (a turn that
 * changed, a hedge that lost) report no usage; their input is estimated from
 * the prompt length and counted as billed, so cost estimates err high.
 */
export class UsageMeter {
  readonly #models = new Map<string, ModelUsage>();

  #of(model: string): ModelUsage {
    let u = this.#models.get(model);
    if (!u) {
      u = empty();
      this.#models.set(model, u);
    }
    return u;
  }

  request(req: TextStreamRequest): void {
    this.#of(req.model).requests++;
  }

  finished(
    model: string,
    usage: { inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null },
    req: TextStreamRequest,
  ): void {
    const u = this.#of(model);
    if (usage.inputTokens === null) u.estimatedInputTokens += estimateTokens(req);
    else u.inputTokens += usage.inputTokens;
    u.cachedTokens += usage.cachedTokens ?? 0;
    u.outputTokens += usage.outputTokens ?? 0;
  }

  cancelled(req: TextStreamRequest): void {
    const u = this.#of(req.model);
    u.cancelled++;
    u.estimatedInputTokens += estimateTokens(req);
  }

  snapshot(): Record<string, ModelUsage> {
    return Object.fromEntries([...this.#models].map(([k, v]) => [k, { ...v }]));
  }
}

export function estimateTokens(req: Pick<TextStreamRequest, 'system' | 'text'>): number {
  return Math.ceil((req.system.length + req.text.length) / CHARS_PER_TOKEN);
}

/** The provider, with every live request counted by `meter`. */
export function meteredProvider(provider: AiProvider, meter: UsageMeter): AiProvider {
  return {
    id: provider.id,
    listModels: (key, signal) => provider.listModels(key, signal),
    generateStructured: (req) => provider.generateStructured(req),
    warmUp: (key, model) => provider.warmUp(key, model),
    toAppError: (err) => provider.toAppError(err),
    async streamText(req) {
      meter.request(req);
      try {
        const res = await provider.streamText(req);
        meter.finished(req.model, res, req);
        return res;
      } catch (err) {
        if (req.signal?.aborted) meter.cancelled(req);
        else
          meter.finished(req.model, { inputTokens: null, cachedTokens: 0, outputTokens: 0 }, req);
        throw err;
      }
    },
  };
}
