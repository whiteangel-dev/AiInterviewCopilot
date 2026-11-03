/** Lower-cases, strips punctuation and splits into words for WER scoring. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate = (substitutions + deletions + insertions) / reference words. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return (prev[hyp.length] ?? 0) / ref.length;
}
