import { AppError } from '@aic/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeProvider } from '../providers/fake';
import type { AiProvider, TextStreamRequest, TextStreamResponse } from '../providers/types';
import { forgetUnavailableModels } from '../providers/availability';
import { HedgeTimer, isRetryableLiveError, streamHedged } from './hedge';

interface Call {
  req: TextStreamRequest;
  text(piece: string): void;
  done(): void;
  fail(err: unknown): void;
}

/** A provider whose requests the test drives by hand. */
function scripted() {
  const calls: Call[] = [];
  const fake = new FakeProvider();
  const provider: AiProvider = {
    id: 'gemini',
    listModels: () => Promise.resolve([]),
    generateStructured: () => Promise.reject(new Error('unused')),
    warmUp: () => Promise.resolve(),
    toAppError: (e) => fake.toAppError(e),
    streamText: (req) =>
      new Promise<TextStreamResponse>((resolve, reject) => {
        let text = '';
        req.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
        calls.push({
          req,
          text: (piece) => {
            text += piece;
            req.onText?.(piece);
          },
          done: () =>
            resolve({
              text,
              model: req.model,
              inputTokens: 10,
              cachedTokens: 0,
              outputTokens: 5,
              firstTextMs: 100,
              durationMs: 200,
              finishReason: 'STOP',
            }),
          fail: reject,
        });
      }),
  };
  return { provider, calls };
}

const base = (onText: (p: string) => void, signal?: AbortSignal): TextStreamRequest => ({
  apiKey: 'k',
  model: 'primary',
  system: 's',
  text: 't',
  thinking: 'minimal',
  maxOutputTokens: 100,
  task: 'live-answer',
  onText,
  ...(signal ? { signal } : {}),
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('streamHedged', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses the first request when it answers in time', async () => {
    const { provider, calls } = scripted();
    const seen: string[] = [];
    const p = streamHedged(
      provider,
      base((t) => seen.push(t)),
      {
        hedgeAfterMs: 900,
        fallbackModels: ['backup'],
      },
    );
    calls[0]!.text('Hello');
    vi.advanceTimersByTime(2000);
    calls[0]!.done();
    await expect(p).resolves.toMatchObject({ text: 'Hello', requests: 1, hedged: false });
    expect(calls).toHaveLength(1);
    expect(seen).toEqual(['Hello']);
  });

  it('sends a duplicate when the first is slow, and keeps whichever shows text first', async () => {
    const { provider, calls } = scripted();
    const seen: string[] = [];
    const p = streamHedged(
      provider,
      base((t) => seen.push(t)),
      {
        hedgeAfterMs: 900,
        fallbackModels: [],
      },
    );
    vi.advanceTimersByTime(900);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.req.model).toBe('primary');
    calls[1]!.text('Fast');
    // The slow one is cancelled; its text never reaches the caller.
    expect(calls[0]!.req.signal?.aborted).toBe(true);
    calls[0]!.text('Slow');
    calls[1]!.text(' answer');
    calls[1]!.done();
    await expect(p).resolves.toMatchObject({ text: 'Fast answer', requests: 2, hedged: true });
    expect(seen).toEqual(['Fast', ' answer']);
  });

  it('fails over to the backup model when a request fails before any text', async () => {
    const { provider, calls } = scripted();
    const p = streamHedged(
      provider,
      base(() => undefined),
      {
        hedgeAfterMs: 900,
        fallbackModels: ['backup'],
      },
    );
    calls[0]!.fail(new AppError('quota', 'Rate limited.'));
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.req.model).toBe('backup');
    // No hedge to a model that just failed.
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(2);
    calls[1]!.text('From backup');
    calls[1]!.done();
    await expect(p).resolves.toMatchObject({ model: 'backup', failedOver: true, requests: 2 });
  });

  it('skips a model the key turned out not to have', async () => {
    forgetUnavailableModels();
    const { provider, calls } = scripted();
    const first = streamHedged(
      provider,
      base(() => undefined),
      {
        hedgeAfterMs: null,
        fallbackModels: ['backup'],
      },
    );
    calls[0]!.fail(new AppError('quota', 'Not on the free tier.', { modelUnavailable: true }));
    await flush();
    calls[1]!.text('ok');
    calls[1]!.done();
    await first;
    // The next request starts on the backup.
    const second = streamHedged(
      provider,
      base(() => undefined),
      {
        hedgeAfterMs: null,
        fallbackModels: ['backup'],
      },
    );
    expect(calls[2]!.req.model).toBe('backup');
    calls[2]!.text('ok');
    calls[2]!.done();
    await expect(second).resolves.toMatchObject({ failedOver: true });
    forgetUnavailableModels();
  });

  it('can race two requests from the start, and reports rate limits', async () => {
    const { provider, calls } = scripted();
    const p = streamHedged(
      provider,
      base(() => undefined),
      {
        hedgeAfterMs: 0,
        fallbackModels: ['backup'],
      },
    );
    vi.advanceTimersByTime(0);
    expect(calls).toHaveLength(2);
    calls[0]!.fail(new AppError('quota', 'Rate limited.'));
    await flush();
    calls[1]!.text('ok');
    calls[1]!.done();
    await expect(p).resolves.toMatchObject({ hedged: true, rateLimited: true });
  });

  it('reports the error when nothing is left to try', async () => {
    const { provider, calls } = scripted();
    const p = streamHedged(
      provider,
      base(() => undefined),
      {
        hedgeAfterMs: null,
        fallbackModels: ['backup'],
      },
    );
    calls[0]!.fail(new AppError('network', "Couldn't reach Google.", { retryable: true }));
    await flush();
    calls[1]!.fail(new AppError('network', 'Still down.', { retryable: true }));
    await expect(p).rejects.toMatchObject({ code: 'network', message: "Couldn't reach Google." });
  });

  it('does not retry a bad key, or a failure after text was shown', async () => {
    const { provider, calls } = scripted();
    const bad = streamHedged(
      provider,
      base(() => undefined),
      {
        hedgeAfterMs: null,
        fallbackModels: ['backup'],
      },
    );
    calls[0]!.fail(new AppError('invalid_api_key', 'Bad key.'));
    await expect(bad).rejects.toMatchObject({ code: 'invalid_api_key' });
    expect(calls).toHaveLength(1);

    const mid = streamHedged(
      provider,
      base(() => undefined),
      {
        hedgeAfterMs: null,
        fallbackModels: ['backup'],
      },
    );
    calls[1]!.text('Half an');
    calls[1]!.fail(new AppError('network', 'Dropped.', { retryable: true }));
    await expect(mid).rejects.toMatchObject({ code: 'network' });
    expect(calls).toHaveLength(2);
  });

  it('cancels every request when the caller cancels', async () => {
    const { provider, calls } = scripted();
    const ac = new AbortController();
    const p = streamHedged(
      provider,
      base(() => undefined, ac.signal),
      {
        hedgeAfterMs: 500,
        fallbackModels: [],
      },
    );
    vi.advanceTimersByTime(500);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls.every((c) => c.req.signal?.aborted)).toBe(true);
  });

  it('classifies retryable errors', () => {
    expect(isRetryableLiveError(new AppError('quota', 'x'))).toBe(true);
    expect(isRetryableLiveError(new AppError('invalid_api_key', 'x'))).toBe(false);
    expect(
      isRetryableLiveError(
        new AppError('provider_error', "The selected model isn't available to this key."),
      ),
    ).toBe(true);
    expect(isRetryableLiveError(new AppError('provider_error', 'Rejected: bad request'))).toBe(
      false,
    );
  });
});

describe('HedgeTimer', () => {
  it('hedges at about the 90th percentile of recent first-text times, within bounds', () => {
    const t = new HedgeTimer(1000, 600, 1600, 20);
    expect(t.delayMs).toBe(1000);
    for (const ms of [500, 520, 600, 640, 700, 650, 610, 590, 560, 1300]) t.add(ms);
    expect(t.delayMs).toBe(700);
    for (let i = 0; i < 20; i++) t.add(300);
    expect(t.delayMs).toBe(600);
    for (let i = 0; i < 20; i++) t.add(5000);
    expect(t.delayMs).toBe(1600);
    t.add(null);
    expect(t.delayMs).toBe(1600);
  });
});
