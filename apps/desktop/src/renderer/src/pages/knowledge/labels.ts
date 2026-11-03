import type {
  KnowledgeCategory,
  KnowledgeIssueType,
  KnowledgeItemFields,
  KnowledgeKind,
} from '@aic/ipc';

export const EMPTY_ITEM: KnowledgeItemFields = {
  kind: 'fact',
  category: 'other',
  title: '',
  content: '',
};

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

export const KIND_LABELS: Record<KnowledgeKind, string> = {
  fact: 'Fact',
  instruction: 'Instruction',
};

export const ISSUE_LABELS: Record<KnowledgeIssueType, string> = {
  duplicate: 'Duplicate',
  conflict: 'Conflict',
  unclear: 'Unclear',
  misplaced: 'Misfiled',
  risky: 'Risky',
};
