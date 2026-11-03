import {
  DEFAULT_MODELS,
  MODEL_ROLE_KIND,
  MODEL_ROLES,
  type ModelInfo,
  type ModelKind,
  type ModelRole,
  type ModelRoles,
} from '@aic/ipc';

/** Classifies a Gemini model from its name and supported actions. */
export function classifyGeminiModel(id: string, actions: readonly string[]): ModelKind {
  if (actions.includes('bidiGenerateContent')) return 'live';
  if (/tts/.test(id)) return 'tts';
  if (actions.some((a) => /embed/i.test(a))) return 'embedding';
  if (/image|imagen|veo|lyria|nano-banana/.test(id)) return 'image';
  if (/robotics|computer-use|deep-research|antigravity|^aqa$/.test(id)) return 'other';
  if (actions.includes('generateContent')) return 'text';
  return 'other';
}

const versionOf = (id: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);

/** Newest version first; at equal version, stable before preview, then by name. */
export function compareNewest(a: string, b: string): number {
  return (
    versionOf(b) - versionOf(a) ||
    Number(a.includes('preview')) - Number(b.includes('preview')) ||
    a.localeCompare(b)
  );
}

/** The model family each role falls back to when its default isn't available. */
const FALLBACK_FAMILY: Record<ModelRole, RegExp> = {
  transcription: /^gemini-\d+(?:\.\d+)?-transcribe-live$/,
  turnAnalyzer: /^gemini-\d+(?:\.\d+)?-flash-lite(?:-preview)?$/,
  answerFast: /^gemini-\d+(?:\.\d+)?-flash-lite(?:-preview)?$/,
  answerQuality: /^gemini-\d+(?:\.\d+)?-pro(?:-preview)?$/,
  preparation: /^gemini-\d+(?:\.\d+)?-pro(?:-preview)?$/,
};

/**
 * Recommends a model per role from what the key can access. The defaults were
 * measured in Phase 0, so they win whenever available; a newer model is not
 * assumed to be faster (gemini-3.8-flash was 3.6× slower to first token than
 * gemini-3.5-flash-lite). Otherwise the newest model of the same family is used.
 */
export function recommendModels(models: readonly ModelInfo[]): Partial<ModelRoles> {
  const out: Partial<ModelRoles> = {};
  for (const role of MODEL_ROLES) {
    const kind: ModelKind = MODEL_ROLE_KIND[role];
    const fallback = FALLBACK_FAMILY[role];
    const candidates = models.filter((m) => m.kind === kind).map((m) => m.id);
    if (candidates.includes(DEFAULT_MODELS[role])) {
      out[role] = DEFAULT_MODELS[role];
      continue;
    }
    const best = candidates.filter((id) => fallback.test(id)).sort(compareNewest)[0];
    if (best) out[role] = best;
  }
  return out;
}
