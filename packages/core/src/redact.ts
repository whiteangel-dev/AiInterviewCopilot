/**
 * Removes secrets from text before it is logged or shown. Known key formats are
 * matched by pattern; the active key values are also registered and replaced
 * exactly, whatever their format.
 */
const PATTERNS: [RegExp, string][] = [
  [/AIza[0-9A-Za-z_-]{20,}/g, '<redacted-key>'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '<redacted-key>'],
  [/([?&](?:key|api_key|apikey)=)[^&\s"'#]+/gi, '$1<redacted>'],
  [/((?:x-goog-api-key|x-api-key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1<redacted>'],
];

const MIN_SECRET_LENGTH = 8;
const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value.length >= MIN_SECRET_LENGTH) secrets.add(value);
}

export function unregisterSecret(value: string): void {
  secrets.delete(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.replaceAll(secret, '<redacted>');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
