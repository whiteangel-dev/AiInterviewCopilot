import { afterEach, describe, expect, it } from 'vitest';
import { KEY, call, cleanup, setup } from './test-helpers';

afterEach(cleanup);

describe('keys from a key file', () => {
  it('remembers where a key came from, and stops using it once expired', async () => {
    const { h, init } = await setup(null);
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    let status = await h['apiKey.activate']({
      provider: 'gemini',
      key: KEY,
      verification: null,
      models: null,
      origin: { source: 'file', label: 'For Alex', expiresAt: tomorrow },
    });
    expect(status).toMatchObject({
      configured: true,
      source: 'file',
      label: 'For Alex',
      expiresAt: tomorrow,
      expired: false,
    });
    await expect(h['models.list']({ provider: 'gemini', refresh: false })).resolves.toBeTruthy();

    // An expired key file is refused wherever the key would be used.
    status = await h['apiKey.activate']({
      provider: 'gemini',
      key: KEY,
      verification: null,
      models: null,
      origin: { source: 'file', label: 'For Alex', expiresAt: Date.now() - 1000 },
    });
    expect(status.expired).toBe(true);
    await expect(
      call(() => h['models.list']({ provider: 'gemini', refresh: true })),
    ).rejects.toMatchObject({ code: 'invalid_api_key', message: /expired/ });

    // After a restart, the stored origin still applies.
    await h.shutdown();
    const again = await setup(null, init);
    await again.h['apiKey.activate']({
      provider: 'gemini',
      key: KEY,
      verification: null,
      models: null,
    });
    expect(await again.h['apiKey.status']({ provider: 'gemini' })).toMatchObject({
      source: 'file',
      expired: true,
    });

    // Typing a key in replaces it.
    status = await again.h['apiKey.activate']({
      provider: 'gemini',
      key: KEY,
      verification: { outcome: 'valid', message: null, checkedAt: Date.now() },
      models: null,
      origin: { source: 'typed', label: null, expiresAt: null },
    });
    expect(status).toMatchObject({ source: 'typed', label: null, expiresAt: null, expired: false });
  });
});
