/**
 * Models this key can't use (for example a Pro model on Google's free tier).
 * Remembered so later requests go straight to a fallback instead of failing
 * first. Forgotten when the key changes.
 */
const unavailable = new Set<string>();

export function markModelUnavailable(model: string): void {
  unavailable.add(model);
}

export function isModelUnavailable(model: string): boolean {
  return unavailable.has(model);
}

export function forgetUnavailableModels(): void {
  unavailable.clear();
}

/** The models to try, in order, skipping known-unavailable ones (but never all of them). */
export function usableModels(models: readonly string[]): string[] {
  const unique = [...new Set(models)];
  const usable = unique.filter((m) => !unavailable.has(m));
  return usable.length > 0 ? usable : unique.slice(-1);
}

/** The free model preparation falls back to when the key can't use the preferred one. */
export const FREE_PREPARATION_MODEL = 'gemini-3.8-flash';
