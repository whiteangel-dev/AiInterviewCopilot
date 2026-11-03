import { z } from 'zod';

/**
 * Application Knowledge: notes the candidate wants the copilot to know that
 * aren't (fully) in the resume. Facts are true statements about the candidate;
 * instructions say how to answer.
 */
export const KnowledgeKindSchema = z.enum(['fact', 'instruction']);
export type KnowledgeKind = z.infer<typeof KnowledgeKindSchema>;

export const KNOWLEDGE_CATEGORIES = [
  'experience',
  'project',
  'personal',
  'compensation',
  'style',
  'technical',
  'company',
  'other',
] as const;
export const KnowledgeCategorySchema = z.enum(KNOWLEDGE_CATEGORIES);
export type KnowledgeCategory = z.infer<typeof KnowledgeCategorySchema>;

export const KnowledgeItemFieldsSchema = z.object({
  kind: KnowledgeKindSchema,
  category: KnowledgeCategorySchema,
  title: z.string().trim().max(120),
  content: z.string().trim().min(1, 'Write something first.').max(6000),
});
export type KnowledgeItemFields = z.infer<typeof KnowledgeItemFieldsSchema>;

export interface KnowledgeItem extends KnowledgeItemFields {
  id: string;
  baseId: string;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  description: string;
  itemCount: number;
  updatedAt: number;
}

export const KnowledgeIssueTypeSchema = z.enum([
  'duplicate',
  'conflict',
  'unclear',
  'misplaced',
  'risky',
]);
export type KnowledgeIssueType = z.infer<typeof KnowledgeIssueTypeSchema>;

export interface KnowledgeIssue {
  type: KnowledgeIssueType;
  itemIds: string[];
  /** The resume profile is part of the conflict. */
  involvesResume: boolean;
  message: string;
  suggestion: string | null;
}

export interface KnowledgeAnalysis {
  id: string;
  baseId: string;
  profileId: string | null;
  createdAt: number;
  model: string;
  /** Items changed since the analysis ran. */
  stale: boolean;
  summary: string;
  issues: KnowledgeIssue[];
  reclassify: { itemId: string; kind: KnowledgeKind; category: KnowledgeCategory }[];
}

export interface KnowledgeBaseDetail {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  items: KnowledgeItem[];
  analysis: KnowledgeAnalysis | null;
}

export interface ContextPreview {
  text: string;
  approxTokens: number;
  sections: { title: string; approxTokens: number }[];
}
