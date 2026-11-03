import { readFileSync } from 'node:fs';
import { ApiError } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { FakeProvider } from './fake';
import { GeminiProvider } from './gemini';
import { verifyApiKey } from './verify';

describe('GeminiProvider.toAppError', () => {
  const provider = new GeminiProvider();
  const apiError = (status: number, message: string) => new ApiError({ status, message });

  it('maps rejected keys, quota and server errors', () => {
    expect(
      provider.toAppError(apiError(400, 'API key not valid. Please pass a valid API key.')).code,
    ).toBe('invalid_api_key');
    expect(provider.toAppError(apiError(403, 'PERMISSION_DENIED')).code).toBe('invalid_api_key');
    expect(provider.toAppError(apiError(429, 'RESOURCE_EXHAUSTED')).code).toBe('quota');
    expect(provider.toAppError(apiError(503, 'UNAVAILABLE'))).toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
    expect(provider.toAppError(apiError(429, 'RESOURCE_EXHAUSTED')).retryable).toBe(false);
    expect(provider.toAppError(apiError(400, 'Invalid argument')).code).toBe('provider_error');
  });

  it('maps network failures', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    });
    expect(provider.toAppError(err).code).toBe('network');
  });
});

describe('verifyApiKey', () => {
  const fake = new FakeProvider();

  it('valid key returns models', async () => {
    const result = await verifyApiKey(fake, 'AIza-test-key-0000000000000');
    expect(result.verification.outcome).toBe('valid');
    expect(result.models?.length).toBeGreaterThan(0);
  });

  it('rejected key is invalid; network failure is unverified', async () => {
    expect((await verifyApiKey(fake, 'INVALID-key-000000000000')).verification.outcome).toBe(
      'invalid',
    );
    const offline = await verifyApiKey(fake, 'OFFLINE-key-000000000000');
    expect(offline.verification).toMatchObject({ outcome: 'unverified' });
    expect(offline.models).toBeNull();
  });
});

/** Reads the developer's key from `.env.local` (never printed). CI has no key, so this is skipped. */
function devKey(): string | undefined {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const text = readFileSync(new URL('../../../../.env.local', import.meta.url), 'utf8');
    const vars: Record<string, string | undefined> = Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((l) => /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*[=:]\s*(.*?)\s*$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1] ?? '', m[2]?.replace(/^["']|["']$/g, '')] as const),
    );
    return vars.GEMINI_API_KEY || vars.GOOGLE_API_KEY || vars.API_KEY || undefined;
  } catch {
    return undefined;
  }
}

const key = process.env.AIC_LIVE_TESTS === '1' ? devKey() : undefined;

describe.skipIf(!key)('GeminiProvider (live, AIC_LIVE_TESTS=1)', () => {
  const provider = new GeminiProvider();

  it('lists models with a real key', async () => {
    const result = await verifyApiKey(provider, key!);
    expect(result.verification.outcome).toBe('valid');
    expect(result.models?.some((m) => m.id === 'gemini-3.5-flash-lite')).toBe(true);
  }, 20_000);

  it('rejects a fake key', async () => {
    const result = await verifyApiKey(provider, 'AIza' + 'Q'.repeat(35));
    expect(result.verification.outcome).toBe('invalid');
  }, 20_000);
});
