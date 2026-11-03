import { randomBytes } from 'node:crypto';
import { AppError } from '@aic/ipc';
import type { SecretStore } from './secret-store';

export const DB_KEY_SECRET = 'db.key';

/**
 * Returns the database key, creating one for a new install. A database without
 * its key can't be opened, so that case fails with `db_unlock_failed`.
 */
export async function loadOrCreateDbKey(
  store: SecretStore,
  databaseExists: boolean,
): Promise<string> {
  let existing: string | null;
  try {
    existing = await store.get(DB_KEY_SECRET);
  } catch (err) {
    throw new AppError(
      'db_unlock_failed',
      "The key that protects your local data couldn't be read on this device or Windows account.",
      { cause: err },
    );
  }
  if (existing) return existing;
  if (databaseExists) {
    throw new AppError(
      'db_unlock_failed',
      'The key that protects your local data is missing, so the data cannot be opened.',
    );
  }
  const key = randomBytes(32).toString('hex');
  await store.set(DB_KEY_SECRET, key);
  return key;
}
