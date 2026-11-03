import type { KeyVerification, ModelInfo } from '@aic/ipc';
import type { AiProvider } from './types';

/**
 * Checks a key by listing models. A rejected key is `invalid`; anything else that
 * fails (offline, quota, server error) leaves it `unverified` so the user can still
 * save it and check again later.
 */
export async function verifyApiKey(
  provider: AiProvider,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ verification: KeyVerification; models: ModelInfo[] | null }> {
  const checkedAt = Date.now();
  try {
    const models = await provider.listModels(apiKey, signal);
    return { verification: { outcome: 'valid', message: null, checkedAt }, models };
  } catch (err) {
    const error = provider.toAppError(err);
    return {
      verification: {
        outcome: error.code === 'invalid_api_key' ? 'invalid' : 'unverified',
        message: error.message,
        checkedAt,
      },
      models: null,
    };
  }
}
