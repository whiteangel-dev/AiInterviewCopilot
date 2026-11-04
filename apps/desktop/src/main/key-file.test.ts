import { describe, expect, it } from 'vitest';
import { createKeyFile, readKeyFile } from './key-file';

const KEY = 'test-only-gemini-key-for-key-files-wxyz';

describe('key files', () => {
  it('round-trips a key with its label and expiry, without the key in the file', async () => {
    const expiresAt = Date.UTC(2026, 11, 31);
    const bytes = await createKeyFile({ key: KEY, label: 'For Alex', expiresAt }, 'correct horse');
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('Alex');
    expect(JSON.parse(text)).toMatchObject({ format: 'ai-interview-copilot-key', version: 1 });

    const read = await readKeyFile(bytes, 'correct horse');
    expect(read).toMatchObject({ provider: 'gemini', key: KEY, label: 'For Alex', expiresAt });
    expect(read.createdAt).toBeGreaterThan(0);
  });

  it('refuses a wrong password, a changed file and other files', async () => {
    const bytes = await createKeyFile({ key: KEY, label: '', expiresAt: null }, 'right password');
    await expect(readKeyFile(bytes, 'wrong password')).rejects.toMatchObject({
      code: 'invalid_input',
    });

    // Changing the header (here: a weaker key derivation) breaks it too.
    const file = JSON.parse(new TextDecoder().decode(bytes)) as { kdf: { r: number } };
    file.kdf.r = 4;
    await expect(
      readKeyFile(new TextEncoder().encode(JSON.stringify(file)), 'right password'),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(readKeyFile(new TextEncoder().encode('{"hello":1}'), 'x')).rejects.toMatchObject({
      code: 'unsupported_file',
    });
    await expect(readKeyFile(new Uint8Array([1, 2, 3]), 'x')).rejects.toMatchObject({
      code: 'unsupported_file',
    });
  });

  it('makes each file different, even for the same key and password', async () => {
    const a = await createKeyFile({ key: KEY, label: '', expiresAt: null }, 'same password');
    const b = await createKeyFile({ key: KEY, label: '', expiresAt: null }, 'same password');
    expect(new TextDecoder().decode(a)).not.toBe(new TextDecoder().decode(b));
  });
});
