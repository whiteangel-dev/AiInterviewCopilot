/**
 * Local question matching for the answer bank: no network, microseconds per
 * question. Word overlap (Dice coefficient) after dropping filler words and
 * light stemming, taking the best of the question and its variants.
 */

const STOPWORDS = new Set(
  `a an the and or but so if of to in on at for from by with as is are was were be been being am
  do does did doing have has had having i me my mine myself we us our you your yours it its this that
  these those there here what which who whom whose when where why how can could would should will shall
  may might must just really very bit little quick quickly briefly please tell talk say share give
  about let us like kind sort maybe also then now okay ok well um uh yeah right go ahead first
  not over than versus vs instead rather`
    .split(/\s+/)
    .filter(Boolean),
);

function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4)
      return word.slice(0, -suffix.length);
  }
  return word;
}

export function questionTokens(text: string): Set<string> {
  const words =
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[’']/g, '')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)).map(stem));
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export interface Matchable {
  question: string;
  variants: readonly string[];
}

export interface QuestionMatch<T extends Matchable> {
  item: T;
  score: number;
  matchedText: string;
}

/** Above this, a prepared answer can be shown without asking the model. */
export const CONFIDENT_MATCH = 0.6;

/** Best matches first; only those scoring at least `minScore`. */
export function matchQuestion<T extends Matchable>(
  question: string,
  items: readonly T[],
  { limit = 3, minScore = 0.3 } = {},
): QuestionMatch<T>[] {
  const q = questionTokens(question);
  const results: QuestionMatch<T>[] = [];
  for (const item of items) {
    let best = { score: 0, text: item.question };
    for (const text of [item.question, ...item.variants]) {
      const score = dice(q, questionTokens(text));
      if (score > best.score) best = { score, text };
    }
    if (best.score >= minScore)
      results.push({ item, score: Math.round(best.score * 100) / 100, matchedText: best.text });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * The parts of something an interviewer said that may be the question: the
 * whole text, each sentence, and each sentence without a lead-in before its
 * first comma ("To get started, can you tell me about yourself?").
 */
export function questionCandidates(heard: string): string[] {
  const out = new Set<string>();
  const add = (t: string) => {
    const s = t.trim();
    if (s.split(/\s+/).length >= 2) out.add(s);
  };
  add(heard);
  for (const sentence of heard.match(/[^.?!]+[.?!]*/g) ?? []) {
    add(sentence);
    const comma = sentence.indexOf(',');
    if (comma > 0) add(sentence.slice(comma + 1));
  }
  return [...out];
}

/**
 * Matches live speech against prepared questions: the best score over all of
 * `questionCandidates(heard)`, so lead-ins and small talk don't hide the question.
 */
export function matchHeard<T extends Matchable>(
  heard: string,
  items: readonly T[],
  { minScore = CONFIDENT_MATCH } = {},
): QuestionMatch<T> | null {
  let best: QuestionMatch<T> | null = null;
  for (const candidate of questionCandidates(heard)) {
    const [m] = matchQuestion(candidate, items, { limit: 1, minScore });
    if (m && (!best || m.score > best.score)) best = m;
  }
  return best;
}
