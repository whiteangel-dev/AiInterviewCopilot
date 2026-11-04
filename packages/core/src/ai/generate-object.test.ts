import { AppError } from '@aic/ipc';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { forgetUnavailableModels, isModelUnavailable } from '../providers/availability';
import { FakeProvider } from '../providers/fake';
import type { AiProvider, StructuredResponse } from '../providers/types';
import { generateObject, toModelSchema } from './generate-object';

const Schema = z.object({ name: z.string(), age: z.number().nullable() });

function stub(replies: string[]): AiProvider {
  const fake = new FakeProvider();
  return {
    id: 'gemini',
    listModels: () => Promise.resolve([]),
    generateStructured: vi.fn((): Promise<StructuredResponse> =>
      Promise.resolve({
        text: replies.shift() ?? '',
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
      }),
    ),
    streamText: (req) => fake.streamText(req),
    warmUp: () => Promise.resolve(),
    toAppError: (e) => fake.toAppError(e),
  };
}

const request = {
  apiKey: 'k',
  model: 'm',
  system: 's',
  parts: [{ text: 'x' }],
  task: 't',
  schema: Schema,
};

describe('generateObject', () => {
  it('produces a JSON schema the Gemini API accepts', () => {
    const s = toModelSchema(Schema);
    expect(s).not.toHaveProperty('$schema');
    expect(s).toMatchObject({ type: 'object', required: ['name', 'age'] });
  });

  it('validates the reply', async () => {
    const r = await generateObject(stub(['{"name":"A","age":null}']), request);
    expect(r).toMatchObject({ data: { name: 'A', age: null }, attempts: 1 });
  });

  it('retries once on a truncated or malformed reply', async () => {
    const provider = stub(['{"name":"A"', '{"name":"B","age":3}']);
    const r = await generateObject(provider, request);
    expect(r.data.name).toBe('B');
    expect(r.attempts).toBe(2);
  });

  it('retries temporary failures, then gives up', async () => {
    const fail = new AppError('provider_error', 'HTTP 503', { retryable: true });
    let calls = 0;
    const flaky: AiProvider = {
      ...stub([]),
      generateStructured: () => {
        calls++;
        return calls < 3
          ? Promise.reject(fail)
          : Promise.resolve({
              text: '{"name":"C","age":1}',
              model: 'm',
              inputTokens: 1,
              outputTokens: 1,
              durationMs: 1,
            });
      },
    };
    const r = await generateObject(flaky, request, { retryDelaysMs: [1, 1] });
    expect(r.data.name).toBe('C');
    expect(calls).toBe(3);

    calls = -10; // always failing
    await expect(generateObject(flaky, request, { retryDelaysMs: [1, 1] })).rejects.toBe(fail);
  });

  it('switches to a fallback model the key can use, and remembers', async () => {
    forgetUnavailableModels();
    const asked: string[] = [];
    const freeKey: AiProvider = {
      ...stub([]),
      generateStructured: (req) => {
        asked.push(req.model);
        return req.model === 'pro'
          ? Promise.reject(
              new AppError('quota', 'Not on the free tier.', { modelUnavailable: true }),
            )
          : Promise.resolve({
              text: '{"name":"F","age":2}',
              model: req.model,
              inputTokens: 1,
              outputTokens: 1,
              durationMs: 1,
            });
      },
    };
    const r = await generateObject(
      freeKey,
      { ...request, model: 'pro' },
      { fallbackModels: ['flash'] },
    );
    expect(r.data.name).toBe('F');
    expect(r.response.model).toBe('flash');
    expect(isModelUnavailable('pro')).toBe(true);
    // Next time it goes straight to the fallback.
    await generateObject(freeKey, { ...request, model: 'pro' }, { fallbackModels: ['flash'] });
    expect(asked).toEqual(['pro', 'flash', 'flash']);
    forgetUnavailableModels();
  });

  it('does not retry permanent failures', async () => {
    let calls = 0;
    const rejected: AiProvider = {
      ...stub([]),
      generateStructured: () => {
        calls++;
        return Promise.reject(new AppError('invalid_api_key', 'nope'));
      },
    };
    await expect(
      generateObject(rejected, request, { retryDelaysMs: [1, 1] }),
    ).rejects.toMatchObject({ code: 'invalid_api_key' });
    expect(calls).toBe(1);
  });

  it('gives up with ai_output_invalid', async () => {
    await expect(generateObject(stub(['{}', '{"name":1}']), request)).rejects.toMatchObject({
      code: 'ai_output_invalid',
    });
  });

  it('honors cancellation', async () => {
    const controller = new AbortController();
    const p = generateObject(new FakeProvider(200), {
      ...request,
      task: 'answer_bank',
      schema: z.unknown(),
      signal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });
});
