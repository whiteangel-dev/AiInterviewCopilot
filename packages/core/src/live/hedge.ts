import { AppError } from '@aic/ipc';
import { markModelUnavailable, usableModels } from '../providers/availability';
import type { AiProvider, TextStreamRequest, TextStreamResponse } from '../providers/types';

/**
 * Hedged, fail-over live requests (Phase 5). The model's time to first text
 * varies a lot from request to request (0.45–2 s for the same prompt, measured
 * in Phase 4), so:
 *
 * - **Hedge:** if no text has arrived after `hedgeAfterMs`, send the same
 *   request again. Whichever request shows text first wins; the other is
 *   cancelled. Only the slow tail pays for a second request.
 * - **Fail over:** if a request fails before any text (rate limit, server
 *   error, network, model unavailable), switch to the next fallback model at
 *   once instead of failing the answer.
 *
 * Only the winner's text reaches `onText`, so the caller never sees two
 * answers interleaved. Once text has been shown, a failure is not retried
 * (the answer would start over).
 */

export interface HedgeOptions {
  /** Send a duplicate when no text has arrived after this long (ms); null: never. */
  hedgeAfterMs: number | null;
  /** Models to switch to, in order, when a request fails before any text. */
  fallbackModels: readonly string[];
}

export interface HedgedResponse extends TextStreamResponse {
  /** Requests sent: 1 when the first one simply answered. */
  requests: number;
  hedged: boolean;
  /** The answer came from a fallback model. */
  failedOver: boolean;
  /** A request was refused for a rate limit (send fewer requests from now on). */
  rateLimited: boolean;
}

/** Failures another request (or another model) may not have. */
export function isRetryableLiveError(err: AppError): boolean {
  if (err.code === 'quota' || err.code === 'network' || err.modelUnavailable) return true;
  if (err.code !== 'provider_error') return false;
  return (
    err.retryable ||
    /isn't available|not found|overloaded|unavailable|deadline|no text/i.test(err.message)
  );
}

interface Leg {
  model: string;
  kind: 'primary' | 'hedge' | 'fallback';
  controller: AbortController;
  done: boolean;
}

function cancelled(): AppError {
  return new AppError('cancelled', 'Cancelled.');
}

export function streamHedged(
  provider: AiProvider,
  request: TextStreamRequest,
  options: HedgeOptions,
): Promise<HedgedResponse> {
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(cancelled());
      return;
    }
    const legs: Leg[] = [];
    const startedAt = performance.now();
    let firstTextAt: number | null = null;
    // Models this key can't use (e.g. Pro on a free key) are skipped from the start.
    const [first, ...fallbacks] = usableModels([request.model, ...options.fallbackModels]);
    let winner: Leg | null = null;
    let settled = false;
    let firstError: AppError | null = null;
    let failures = 0;
    let rateLimited = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      request.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      for (const leg of legs) leg.controller.abort();
      finish(() => reject(cancelled()));
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const running = () => legs.some((l) => !l.done && !l.controller.signal.aborted);

    const fail = (model: string, err: AppError) => {
      failures++;
      if (err.modelUnavailable) markModelUnavailable(model);
      else if (err.code === 'quota') rateLimited = true;
      firstError ??= err;
      const next = isRetryableLiveError(err) ? fallbacks.shift() : undefined;
      if (next) start(next, 'fallback');
      else if (!running()) finish(() => reject(firstError!));
    };

    const start = (model: string, kind: Leg['kind']) => {
      const leg: Leg = { model, kind, controller: new AbortController(), done: false };
      legs.push(leg);
      provider
        .streamText({
          ...request,
          model,
          signal: leg.controller.signal,
          onText: (piece) => {
            if (settled || leg.controller.signal.aborted) return;
            if (!winner) {
              winner = leg;
              firstTextAt = performance.now();
              clearTimeout(hedgeTimer);
              for (const other of legs) if (other !== leg) other.controller.abort();
            }
            if (winner === leg) request.onText?.(piece);
          },
        })
        .then(
          (res) => {
            leg.done = true;
            if (settled) return;
            if (winner === leg) {
              finish(() =>
                resolve({
                  ...res,
                  // From the first request, not the winning one.
                  firstTextMs:
                    firstTextAt === null ? res.firstTextMs : Math.round(firstTextAt - startedAt),
                  durationMs: Math.round(performance.now() - startedAt),
                  requests: legs.length,
                  hedged: legs.some((l) => l.kind === 'hedge'),
                  failedOver: leg.kind === 'fallback',
                  rateLimited,
                }),
              );
            } else if (!winner) {
              fail(
                model,
                new AppError('provider_error', 'The model returned no text.', { retryable: true }),
              );
            }
          },
          (err: unknown) => {
            leg.done = true;
            // Cancelled because another request won (or the caller cancelled).
            if (settled || leg.controller.signal.aborted) return;
            const appError = provider.toAppError(err);
            if (winner === leg) finish(() => reject(appError));
            else fail(model, appError);
          },
        );
    };

    start(first!, first === request.model ? 'primary' : 'fallback');
    if (options.hedgeAfterMs !== null) {
      hedgeTimer = setTimeout(() => {
        // Not after a failure: the same model just failed.
        if (!winner && !settled && failures === 0) start(first!, 'hedge');
      }, options.hedgeAfterMs);
    }
  });
}

/**
 * When to hedge: about the 90th percentile of recent first-text times, so
 * roughly one request in ten gets a duplicate. Bounded so a slow day doesn't
 * stop hedging altogether, and a fast day doesn't hedge everything.
 */
export class HedgeTimer {
  readonly #samples: number[] = [];

  constructor(
    private readonly initialMs = 1000,
    private readonly minMs = 800,
    private readonly maxMs = 1600,
    private readonly window = 20,
  ) {}

  /** A first-text time of a request that wasn't hedged. */
  add(ms: number | null): void {
    if (ms === null || !Number.isFinite(ms)) return;
    this.#samples.push(ms);
    if (this.#samples.length > this.window) this.#samples.shift();
  }

  get delayMs(): number {
    if (this.#samples.length < 5) return this.initialMs;
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]!;
    return Math.round(Math.min(this.maxMs, Math.max(this.minMs, p90)));
  }
}
