import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecureStorageLevel } from '@aic/ipc';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateDbKey } from './data-key';
import { SecretStore, type Cipher } from './secret-store';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Reversible stand-in for safeStorage: XOR + a version byte that can be "rotated". */
function fakeCipher(level: SecureStorageLevel = 'os') {
  const state = { version: 1, decryptCalls: 0 };
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  const cipher: Cipher = {
    level: () => Promise.resolve(level),
    encrypt: (plain) =>
      Promise.resolve(Buffer.concat([Buffer.from([state.version]), xor(Buffer.from(plain))])),
    decrypt: (data) => {
      state.decryptCalls++;
      if (data[0] === 0xff) return Promise.reject(new Error('bad'));
      return Promise.resolve({
        value: xor(data.subarray(1)).toString(),
        shouldReEncrypt: data[0] !== state.version,
      });
    },
  };
  return { cipher, state };
}

async function store(level: SecureStorageLevel = 'os') {
  const dir = mkdtempSync(join(tmpdir(), 'aic-secrets-'));
  dirs.push(dir);
  const file = join(dir, 'secrets.json');
  const { cipher, state } = fakeCipher(level);
  const s = new SecretStore(file, cipher);
  await s.init();
  return { s, file, state };
}

describe('SecretStore', () => {
  it('round-trips values and stores only ciphertext', async () => {
    const { s, file } = await store();
    await s.set('apikey.gemini', 'super-secret-value');
    expect(await s.get('apikey.gemini')).toBe('super-secret-value');
    expect(readFileSync(file, 'utf8')).not.toContain('super-secret-value');
    await s.delete('apikey.gemini');
    expect(await s.get('apikey.gemini')).toBeNull();
  });

  it('serializes concurrent writes', async () => {
    const { s } = await store();
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.set(`k${i}`, `v${i}`)));
    for (let i = 0; i < 10; i++) expect(await s.get(`k${i}`)).toBe(`v${i}`);
  });

  it('re-encrypts when the OS key was rotated', async () => {
    const { s, file, state } = await store();
    await s.set('k', 'value');
    const before = readFileSync(file, 'utf8');
    state.version = 2;
    expect(await s.get('k')).toBe('value');
    expect(readFileSync(file, 'utf8')).not.toBe(before);
  });

  it('refuses to store secrets without secure storage', async () => {
    const { s } = await store('unavailable');
    await expect(s.set('k', 'v')).rejects.toMatchObject({ code: 'secure_storage_unavailable' });
  });

  it('reports damaged files and undecryptable entries', async () => {
    const { s, file } = await store();
    writeFileSync(
      file,
      '{"version":1,"entries":{"k":"' + Buffer.from([0xff, 1]).toString('base64') + '"}}',
    );
    await expect(s.get('k')).rejects.toMatchObject({ code: 'secure_storage_unavailable' });
    writeFileSync(file, 'not json');
    await expect(s.get('k')).rejects.toMatchObject({ code: 'secure_storage_unavailable' });
  });
});

describe('loadOrCreateDbKey', () => {
  it('creates a 256-bit key once and returns it afterwards', async () => {
    const { s } = await store();
    const key = await loadOrCreateDbKey(s, false);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadOrCreateDbKey(s, true)).toBe(key);
  });

  it('fails with db_unlock_failed when the database exists but its key is gone or unreadable', async () => {
    const { s, file } = await store();
    await expect(loadOrCreateDbKey(s, true)).rejects.toMatchObject({ code: 'db_unlock_failed' });
    writeFileSync(
      file,
      '{"version":1,"entries":{"db.key":"' + Buffer.from([0xff]).toString('base64') + '"}}',
    );
    await expect(loadOrCreateDbKey(s, true)).rejects.toMatchObject({ code: 'db_unlock_failed' });
  });
});
