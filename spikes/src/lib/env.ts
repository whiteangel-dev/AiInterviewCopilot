import { existsSync, readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

const ENV_FILE = new URL('../../../.env.local', import.meta.url);

/** Parses .env.local leniently: accepts `NAME=value` and `NAME: value`, optional quotes. */
function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Reads the Gemini API key from the environment or .env.local
 * (GEMINI_API_KEY, GOOGLE_API_KEY or API_KEY). The value is never logged.
 */
export function getGeminiKey(): string {
  const file = readEnvFile();
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? file.GEMINI_API_KEY ?? file.GOOGLE_API_KEY ?? file.API_KEY;
  if (!key || key.trim() === '') {
    console.error('Missing API key. Add `GEMINI_API_KEY=...` to .env.local in the project root and save the file.');
    process.exit(2);
  }
  return key.trim();
}

export function createClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: getGeminiKey() });
}

/** Minimal `--name value` / `--flag` argument parser. */
export function parseArgs(argv = process.argv.slice(2)): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(a.slice(2), next);
      i++;
    } else {
      out.set(a.slice(2), 'true');
    }
  }
  return out;
}

/** Strips anything that looks like an API key from error text before printing. */
export function redact(text: string): string {
  return text.replace(/AIza[0-9A-Za-z_-]{20,}/g, '<redacted-key>').replace(/key=[^&\s"]+/g, 'key=<redacted>');
}

export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redact(raw);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
