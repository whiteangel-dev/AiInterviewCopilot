import { z } from 'zod';

/** Prepared answers: drafted ahead of time, approved by the user, matched live. */
export const ANSWER_CATEGORIES = [
  'intro',
  'behavioral',
  'motivation',
  'experience',
  'technical',
  'logistics',
  'closing',
  'other',
] as const;
export const AnswerCategorySchema = z.enum(ANSWER_CATEGORIES);
export type AnswerCategory = z.infer<typeof AnswerCategorySchema>;

export const PreparedAnswerFieldsSchema = z.object({
  question: z.string().trim().min(3, 'Write the question.').max(400),
  /** Other ways an interviewer might ask it; used for matching. */
  variants: z.array(z.string().trim().min(1).max(400)).max(10),
  category: AnswerCategorySchema,
  answer: z.string().trim().min(1, 'Write the answer.').max(4000),
  status: z.enum(['draft', 'approved']),
});
export type PreparedAnswerFields = z.infer<typeof PreparedAnswerFieldsSchema>;

export interface PreparedAnswer extends PreparedAnswerFields {
  id: string;
  profileId: string;
  origin: 'generated' | 'manual';
  createdAt: number;
  updatedAt: number;
}

export interface AnswerMatch {
  answer: PreparedAnswer;
  /** 0–1. Above ~0.6 is a confident match. */
  score: number;
  /** The question or variant that matched best. */
  matchedText: string;
}
