import { AnswerCategorySchema, type Settings } from '@aic/ipc';
import { z } from 'zod';
import { GROUNDING_RULES, VOICE_RULES, formatRules } from './rules';

export const ANSWER_BANK_PROMPT_VERSION = 'answer-bank@3';

/** Asked in almost every interview. "Why here" needs a target company in the notes. */
export const COMMON_QUESTIONS = [
  'Tell me about yourself.',
  'Why are you looking to leave your current role?',
  'What are your greatest strengths?',
  "What's a weakness you're working on?",
  'Tell me about a time you disagreed with a teammate.',
  "Tell me about a project you're proud of.",
  'Tell me about a time something went wrong and how you handled it.',
  'Where do you see yourself in five years?',
  'What are your salary expectations?',
  'Why do you want to work here?',
  'Do you have any questions for us?',
] as const;

export const AnswerBankSchema = z.object({
  answers: z.array(
    z.object({
      question: z.string(),
      variants: z
        .array(z.string())
        .describe('2–4 other ways an interviewer might ask the same question.'),
      category: AnswerCategorySchema,
      answer: z
        .string()
        .describe(
          'The first sentence on its own line, then each bullet on a new line starting with "- ".',
        ),
    }),
  ),
});
export type AnswerBankOutput = z.infer<typeof AnswerBankSchema>;

export function answerBankSystem(length: Settings['answers']['length']): string {
  return `You prepare interview answers ahead of time for a job candidate. They will see them during a live interview and say them in their own voice, in first person.

WHAT TO WRITE
- The common questions listed in the request, except those under ALREADY PREPARED. Skip "Why do you want to work here?" unless CANDIDATE KNOWLEDGE names the target company.
- Then role-specific questions an interviewer would likely ask this candidate: deep dives into their most important projects, technical decisions and trade-offs, and their main skills. Write as many as the request asks for.
- Pick role-specific topics that CANDIDATE PROFILE and CANDIDATE KNOWLEDGE describe with their own specifics (the stories, decisions, and numbers they actually contain). Skip topics you could only answer by guessing details.
- For each question, 2–4 variants: other natural ways an interviewer might phrase it.
- category: intro, behavioral, motivation, experience, technical, logistics, closing, or other.
- For "Do you have any questions for us?", the answer lists the candidate's questions (from CANDIDATE KNOWLEDGE if present).

${GROUNDING_RULES}

${VOICE_RULES}

${formatRules(length)}

FINAL CHECK
Before writing each answer, check every specific in it (tool, number, cause, step, setting, team size) against CANDIDATE PROFILE and CANDIDATE KNOWLEDGE. Remove any that isn't there, however plausible.`;
}

export function answerBankInput(opts: {
  today: string;
  brief: string;
  knowledge: string;
  existing: readonly string[];
  roleSpecificCount: number;
}): string {
  return [
    `SESSION\n- Today's date: ${opts.today}`,
    `CANDIDATE PROFILE\n${opts.brief}`,
    `CANDIDATE KNOWLEDGE\n${opts.knowledge || '(none)'}`,
    `COMMON QUESTIONS\n${COMMON_QUESTIONS.map((q) => `- ${q}`).join('\n')}`,
    `ALREADY PREPARED\n${opts.existing.length ? opts.existing.map((q) => `- ${q}`).join('\n') : '(none)'}`,
    `REQUEST\nWrite the common questions not yet prepared, plus ${opts.roleSpecificCount} role-specific questions.`,
  ].join('\n\n');
}
