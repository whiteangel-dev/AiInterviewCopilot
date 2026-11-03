import type { ModelKind } from './types';

/**
 * Model roles and their defaults. Zod-free so the renderer can import it.
 * Defaults were measured in Phase 0 (docs/phase0/results.md).
 */
export const MODEL_ROLES = [
  'transcription',
  'turnAnalyzer',
  'answerFast',
  'answerQuality',
  'preparation',
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export const DEFAULT_MODELS = {
  transcription: 'gemini-3.5-transcribe-live',
  turnAnalyzer: 'gemini-3.5-flash-lite',
  answerFast: 'gemini-3.5-flash-lite',
  answerQuality: 'gemini-3.1-pro-preview',
  preparation: 'gemini-3.1-pro-preview',
} as const satisfies Record<ModelRole, string>;

/** Which kind of model each role needs: transcription uses the Live API. */
export const MODEL_ROLE_KIND: Record<ModelRole, ModelKind> = {
  transcription: 'live',
  turnAnalyzer: 'text',
  answerFast: 'text',
  answerQuality: 'text',
  preparation: 'text',
};
