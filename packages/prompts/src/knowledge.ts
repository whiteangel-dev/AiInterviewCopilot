import {
  KNOWLEDGE_CATEGORIES,
  KnowledgeCategorySchema,
  KnowledgeIssueTypeSchema,
  KnowledgeKindSchema,
  type KnowledgeCategory,
  type KnowledgeItemFields,
} from '@aic/ipc';
import { z } from 'zod';

export const KNOWLEDGE_ANALYSIS_PROMPT_VERSION = 'knowledge-analysis@2';
export const KNOWLEDGE_SPLIT_PROMPT_VERSION = 'knowledge-split@1';

export const CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  experience: 'Experience details',
  project: 'Projects',
  personal: 'Personal background',
  compensation: 'Salary and logistics',
  style: 'Communication style',
  technical: 'Technical details',
  company: 'Target company',
  other: 'Other',
};

const DEFINITIONS = `Kinds:
- fact: something true about the candidate or their situation.
- instruction: how the assistant should answer (tone, what to say or avoid, how to handle a topic).
Categories: ${KNOWLEDGE_CATEGORIES.map((c) => `${c} (${CATEGORY_LABELS[c]})`).join(', ')}.`;

type Item = Pick<KnowledgeItemFields, 'kind' | 'category' | 'title' | 'content'>;

/**
 * The knowledge block of the answer prompt: instructions first (they steer the
 * answer), then facts grouped by category. Deterministic.
 */
export function compileKnowledge(items: readonly Item[]): string {
  if (items.length === 0) return '';
  const line = (i: Item) =>
    `- ${i.title.trim() ? `${i.title.trim()}: ` : ''}${i.content.trim().replace(/\n+/g, ' ')}`;
  const out: string[] = [];
  const instructions = items.filter((i) => i.kind === 'instruction');
  if (instructions.length)
    out.push('Answer instructions (follow these)', ...instructions.map(line));
  for (const category of KNOWLEDGE_CATEGORIES) {
    const facts = items.filter((i) => i.kind === 'fact' && i.category === category);
    if (facts.length) {
      if (out.length) out.push('');
      out.push(`${CATEGORY_LABELS[category]} (facts)`, ...facts.map(line));
    }
  }
  return out.join('\n');
}

// ── Analysis ────────────────────────────────────────────────────────────────

export const KnowledgeAnalysisSchema = z.object({
  summary: z.string().describe('One or two sentences on how ready these notes are.'),
  issues: z.array(
    z.object({
      type: KnowledgeIssueTypeSchema,
      refs: z.array(z.string()).describe('Refs of the items involved, e.g. ["k2", "k5"].'),
      involvesResume: z.boolean().describe('True if the resume profile is part of the problem.'),
      message: z.string().describe('What is wrong, under 30 words.'),
      suggestion: z
        .string()
        .nullable()
        .describe('A concrete rewrite or action, under 40 words; null if none.'),
    }),
  ),
  reclassify: z
    .array(
      z.object({ ref: z.string(), kind: KnowledgeKindSchema, category: KnowledgeCategorySchema }),
    )
    .describe('Only items whose kind or category is clearly wrong.'),
});
export type KnowledgeAnalysisOutput = z.infer<typeof KnowledgeAnalysisSchema>;

export const KNOWLEDGE_ANALYSIS_SYSTEM = `You review a job candidate's notes ("application knowledge"). An interview assistant will use them, together with the candidate's resume profile, to suggest answers in the candidate's voice during live interviews.

Report only problems that would make those answers wrong, inconsistent, or harmful:
- duplicate: two or more items say essentially the same thing.
- conflict: items contradict each other, or an item contradicts the resume profile (set involvesResume to true).
- unclear: an item is too vague to act on, or an instruction is ambiguous.
- misplaced: an item's kind or category is clearly wrong (also list it in reclassify).
- risky: an item would make the assistant claim experience that neither the resume nor the notes support, or say something likely to hurt the candidate (for example, criticizing a former employer). Salary targets and privacy preferences are normal, not risky.

Rules:
- List the items involved in refs (k1, k2, …). Never invent refs.
- In message and suggestion, the candidate reads the text: name notes by their title or a few of their words, never by ref.
- Report each problem once, under the most fitting type.
- Be specific and brief. No style nitpicks, no praise.
- If nothing is wrong, return an empty issues list.

${DEFINITIONS}`;

export function knowledgeAnalysisInput(
  items: readonly (Item & { ref: string })[],
  brief: string | null,
): string {
  const notes = items
    .map(
      (i) => `[${i.ref}] (${i.kind}, ${i.category}) ${i.title ? `${i.title}: ` : ''}${i.content}`,
    )
    .join('\n');
  return [
    `CANDIDATE NOTES\n${notes}`,
    brief ? `RESUME PROFILE\n${brief}` : 'RESUME PROFILE\n(none selected)',
  ].join('\n\n');
}

// ── Splitting free-form notes into items ──────────────────────────────────────

export const KnowledgeSplitSchema = z.object({
  items: z.array(
    z.object({
      kind: KnowledgeKindSchema,
      category: KnowledgeCategorySchema,
      title: z.string().describe('2–6 words.'),
      content: z.string(),
    }),
  ),
});
export type KnowledgeSplitOutput = z.infer<typeof KnowledgeSplitSchema>;

export const KNOWLEDGE_SPLIT_SYSTEM = `Split a job candidate's notes into separate items for an interview assistant: one idea per item.

Rules:
- Keep the candidate's wording and every detail (names, numbers, dates). Fix only obvious typos. Add nothing.
- Keep first person where the notes use it.
- Don't split a single story or explanation across items.
- Drop headings and empty lines; they aren't items.

${DEFINITIONS}`;
