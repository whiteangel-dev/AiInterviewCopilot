/**
 * Checks that a quote the model attributes to the resume really is in it.
 * Comparison is on word tokens after Unicode normalization, so ligatures,
 * dashes, smart quotes, bullets and line-break hyphenation don't matter.
 */
export function tokenize(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/­/g, '') // soft hyphen
      .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, '$1$2') // word broken across lines
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export interface QuoteIndex {
  tokens: string[];
  positions: Map<string, number[]>;
}

export function buildQuoteIndex(text: string): QuoteIndex {
  const tokens = tokenize(text);
  const positions = new Map<string, number[]>();
  tokens.forEach((t, i) => {
    const list = positions.get(t);
    if (list) list.push(i);
    else positions.set(t, [i]);
  });
  return { tokens, positions };
}

/**
 * True if the quote's tokens appear in order in the document, allowing a few
 * small gaps or dropped words (at least 85% of tokens, span ≤ 1.5× the quote).
 * Numbers get no slack: every token containing a digit must be found, since a
 * changed number is exactly the error this check exists to catch.
 */
export function isQuoteInDocument(quote: string, index: QuoteIndex): boolean {
  const q = tokenize(quote);
  if (q.length === 0) return false;
  const starts = index.positions.get(q[0]!) ?? [];
  const needed = Math.max(1, Math.ceil(q.length * 0.85));
  const maxSpan = Math.ceil(q.length * 1.5) + 2;
  // Also try starting from the second token, in case the first word differs.
  const candidates = [...starts, ...(q.length > 3 ? (index.positions.get(q[1]!) ?? []) : [])];
  for (const start of candidates) {
    let matched = 0;
    let pos = start;
    let missedNumber = false;
    for (const token of q) {
      const limit = Math.min(index.tokens.length, start + maxSpan);
      let found = -1;
      for (let j = pos; j < limit && j <= pos + 3; j++) {
        if (index.tokens[j] === token) {
          found = j;
          break;
        }
      }
      if (found >= 0) {
        matched++;
        pos = found + 1;
      } else if (/\d/.test(token)) {
        missedNumber = true;
        break;
      }
    }
    if (!missedNumber && matched >= needed) return true;
  }
  return false;
}
