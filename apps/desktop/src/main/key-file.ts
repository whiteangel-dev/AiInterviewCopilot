import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { AppError } from '@aic/ipc';

/**
 * Key files: a Gemini API key encrypted with a password, so it can be sent to
 * someone (by email, chat) without exposing it. The password goes by another
 * channel. Inside the app the key is stored like any other (OS-protected) and
 * never displayed.
 *
 * What a key file can't do: hide the key from the person who imports it. The
 * app must send the key to Google, so a technical user can recover it. The
 * real control is a separate key per person, deleted in Google AI Studio when
 * no longer needed.
 *
 * Format (JSON): a header, then AES-256-GCM ciphertext. The key is derived
 * from the password with scrypt (N = 2^17, r = 8: about 128 MiB and a few
 * hundred milliseconds per guess). The header is authenticated, so neither it
 * nor the payload can be changed without the password.
 */

export const KEY_FILE_EXTENSION = 'aickey';
const FORMAT = 'ai-interview-copilot-key' as const;
const VERSION = 1;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keyLength: 32 };
const MAX_MEMORY = 256 * 1024 * 1024;

export interface KeyFileContents {
  provider: 'gemini';
  key: string;
  /** Who or what it's for, shown in the app ("For Alex"). */
  label: string;
  /** Epoch ms after which the app stops using the key; null for no end. */
  expiresAt: number | null;
  createdAt: number;
}

interface KeyFileJson {
  format: typeof FORMAT;
  version: number;
  provider: 'gemini';
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
  data: string;
}

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCb(
      password.normalize('NFKC'),
      salt,
      SCRYPT.keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** The parts of the header that are authenticated with the payload. */
const aad = (f: Pick<KeyFileJson, 'format' | 'version' | 'provider' | 'kdf'>) =>
  Buffer.from(JSON.stringify([f.format, f.version, f.provider, f.kdf]));

export async function createKeyFile(
  contents: Omit<KeyFileContents, 'createdAt' | 'provider'>,
  password: string,
): Promise<Uint8Array> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kdf = {
    name: 'scrypt' as const,
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: salt.toString('base64'),
  };
  const header = { format: FORMAT, version: VERSION, provider: 'gemini' as const, kdf };
  const key = await derive(password, salt, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(header));
  const payload: KeyFileContents = { provider: 'gemini', ...contents, createdAt: Date.now() };
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const file: KeyFileJson = {
    ...header,
    cipher: {
      name: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    },
    data: data.toString('base64'),
  };
  return new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`);
}

const notAKeyFile = () =>
  new AppError('unsupported_file', "That isn't an AI Interview Copilot key file.");

export async function readKeyFile(bytes: Uint8Array, password: string): Promise<KeyFileContents> {
  let file: KeyFileJson;
  try {
    file = JSON.parse(new TextDecoder().decode(bytes)) as KeyFileJson;
  } catch {
    throw notAKeyFile();
  }
  if (
    file?.format !== FORMAT ||
    typeof file.data !== 'string' ||
    file.kdf?.name !== 'scrypt' ||
    file.cipher?.name !== 'aes-256-gcm'
  ) {
    throw notAKeyFile();
  }
  if (file.version !== VERSION) {
    throw new AppError(
      'unsupported_file',
      'This key file was made by a newer version of the app. Update the app and try again.',
    );
  }
  // Refuse key-derivation settings that would take too long or too much memory.
  const { N, r, p } = file.kdf;
  if (
    ![N, r, p].every(Number.isInteger) ||
    N < 2 ** 14 ||
    N > 2 ** 20 ||
    r < 1 ||
    r > 16 ||
    p !== 1
  ) {
    throw notAKeyFile();
  }
  let plain: string;
  try {
    const key = await derive(password, Buffer.from(file.kdf.salt, 'base64'), { N, r, p });
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'));
    decipher.setAAD(aad(file));
    decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
    plain = Buffer.concat([
      decipher.update(Buffer.from(file.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError(
      'invalid_input',
      "That password doesn't open this key file (or the file was changed). Check the password and try again.",
    );
  }
  const contents = JSON.parse(plain) as KeyFileContents;
  if (contents.provider !== 'gemini' || typeof contents.key !== 'string' || !contents.key) {
    throw notAKeyFile();
  }
  return {
    provider: 'gemini',
    key: contents.key,
    label: typeof contents.label === 'string' ? contents.label.slice(0, 80) : '',
    expiresAt: typeof contents.expiresAt === 'number' ? contents.expiresAt : null,
    createdAt: typeof contents.createdAt === 'number' ? contents.createdAt : 0,
  };
}

/** "Expired on Nov 30, 2026." for messages. */
export function expiryText(expiresAt: number): string {
  return new Date(expiresAt).toLocaleDateString('en-US', { dateStyle: 'medium' });
}
