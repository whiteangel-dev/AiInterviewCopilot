import { existsSync } from 'node:fs';
import { AppError, type SecureStorageLevel } from '@aic/ipc';
import { readJsonFile, writeJsonFile } from './json-file';

/** OS-backed string encryption (Electron safeStorage: DPAPI on Windows, Keychain on macOS). */
export interface Cipher {
  level(): Promise<SecureStorageLevel>;
  encrypt(plain: string): Promise<Buffer>;
  /** `shouldReEncrypt` is set when the OS key was rotated. */
  decrypt(data: Buffer): Promise<{ value: string; shouldReEncrypt: boolean }>;
}

interface FileShape {
  version: 1;
  entries: Record<string, string>;
}

function isFileShape(value: unknown): value is FileShape {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.entries === 'object' &&
    v.entries !== null &&
    Object.values(v.entries).every((e) => typeof e === 'string')
  );
}

/**
 * Small named-secret store (the database key, API keys). Each value is encrypted
 * by the OS for the current user; the file holds only ciphertext. Call `init()`
 * once after `app.ready`.
 */
export class SecretStore {
  #level: SecureStorageLevel = 'unavailable';
  /** Serializes read-modify-write cycles on the file. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  async init(): Promise<void> {
    this.#level = await this.cipher.level();
  }

  get level(): SecureStorageLevel {
    return this.#level;
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const data = readJsonFile(this.file);
    if (!isFileShape(data)) {
      throw new AppError('secure_storage_unavailable', 'The saved-secrets file is damaged.');
    }
    return data.entries;
  }

  #write(entries: Record<string, string>): void {
    writeJsonFile(this.file, { version: 1, entries } satisfies FileShape);
  }

  #requireCipher(): void {
    if (this.#level === 'unavailable') {
      throw new AppError(
        'secure_storage_unavailable',
        "This system's secure storage isn't available, so secrets can't be saved safely.",
      );
    }
  }

  get(name: string): Promise<string | null> {
    return this.#serialize(async () => {
      const entries = this.#read();
      const entry = entries[name];
      if (entry === undefined) return null;
      this.#requireCipher();
      let decrypted: { value: string; shouldReEncrypt: boolean };
      try {
        decrypted = await this.cipher.decrypt(Buffer.from(entry, 'base64'));
      } catch (err) {
        throw new AppError(
          'secure_storage_unavailable',
          "A saved secret couldn't be decrypted. It may have been created under another user account.",
          { cause: err },
        );
      }
      if (decrypted.shouldReEncrypt) {
        entries[name] = (await this.cipher.encrypt(decrypted.value)).toString('base64');
        this.#write(entries);
      }
      return decrypted.value;
    });
  }

  set(name: string, value: string): Promise<void> {
    return this.#serialize(async () => {
      this.#requireCipher();
      const encrypted = (await this.cipher.encrypt(value)).toString('base64');
      const entries = this.#read();
      entries[name] = encrypted;
      this.#write(entries);
    });
  }

  delete(name: string): Promise<void> {
    return this.#serialize(() => {
      const entries = this.#read();
      if (name in entries) {
        delete entries[name];
        this.#write(entries);
      }
      return Promise.resolve();
    });
  }
}
