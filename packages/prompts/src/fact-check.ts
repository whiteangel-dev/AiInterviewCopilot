/**
 * Background fact check (Phase 5): after a live answer is written, a second
 * model looks for statements about the candidate that the profile and notes
 * don't support. Phase 0 found small embellishments (an alert put at the
 * wrong employer); the check flags them while the candidate is still reading.
 */

export const FACT_CHECK_PROMPT_VERSION = 'fact-check@1';

export interface FactIssue {
  /** Exact words from the answer. */
  quote: string;
  /** What's wrong, briefly. */
  problem: string;
  /** What the sources do say, if anything. */
  fix: string | null;
}

export const FACT_CHECK_SYSTEM = `You check an answer an interview copilot wrote for a job candidate, before the candidate says it in a live interview. The candidate must never claim anything untrue about themselves.

Find statements in ANSWER about the candidate that CANDIDATE PROFILE and CANDIDATE KNOWLEDGE don't support: their experience, employers, roles, projects, technologies they used, numbers, dates, results, awards, education, team sizes, and personal details or opinions presented as theirs.

Supported (don't report):
- anything the profile or knowledge states, even reworded or summarized;
- durations computed from the dates in the profile and today's date in SESSION;
- general or technical explanations, and how the candidate would approach something;
- questions the candidate asks the interviewer, polite small talk, and facts about the company that SESSION or CANDIDATE KNOWLEDGE gives.

Not supported (report):
- a specific the sources don't give: a tool, number, cause, step, team size, or result;
- something placed at the wrong employer, project or time;
- a number that differs from the sources;
- experience the sources deny or never mention;
- a personal opinion, plan or preference the sources don't contain.

For each problem:
- quote: the shortest exact words from ANSWER that contain the claim, copied character for character;
- problem: what's wrong, under 15 words;
- fix: what the sources say instead, under 15 words, or null.

Report each problem once. If everything is supported, return an empty list.`;

export const FACT_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: ['string', 'null'] },
        },
        required: ['quote', 'problem', 'fix'],
      },
    },
  },
  required: ['issues'],
} as const;

export function factCheckInput(opts: {
  context: string;
  question: string;
  answer: string;
}): string {
  return [
    opts.context.trim(),
    `QUESTION\n${opts.question.trim()}`,
    `ANSWER\n${opts.answer.trim()}`,
  ].join('\n\n');
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Where `quote` appears in `text` (ignoring case, curly quotes and spacing),
 * as [start, end) in `text`; null if it doesn't.
 */
export function findQuote(text: string, quote: string): [number, number] | null {
  const q = norm(quote).replace(/^[\s"'.,;:-]+|[\s"'.,;:-]+$/g, '');
  if (q.length < 3) return null;
  // Map each normalized character back to its position in the original.
  let normalized = '';
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    let ch = norm(text[i]!);
    if (ch === '') ch = ' ';
    if (ch === ' ') {
      if (lastSpace) continue;
      lastSpace = true;
    } else {
      lastSpace = false;
    }
    normalized += ch;
    map.push(i);
  }
  const at = normalized.indexOf(q);
  if (at < 0) return null;
  return [map[at]!, map[at + q.length - 1]! + 1];
}

/** Parses the checker's JSON leniently; keeps only issues whose quote is in the answer. */
export function parseFactCheck(json: string, answer: string): FactIssue[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const issues = (raw as { issues?: unknown })?.issues;
  if (!Array.isArray(issues)) return null;
  const out: FactIssue[] = [];
  for (const item of issues) {
    if (!item || typeof item !== 'object') continue;
    const { quote, problem, fix } = item as Record<string, unknown>;
    if (typeof quote !== 'string' || typeof problem !== 'string') continue;
    const span = findQuote(answer, quote);
    if (!span) continue;
    out.push({
      quote: answer.slice(span[0], span[1]),
      problem: problem.trim().slice(0, 200),
      fix: typeof fix === 'string' && fix.trim() ? fix.trim().slice(0, 200) : null,
    });
  }
  return out;
}
