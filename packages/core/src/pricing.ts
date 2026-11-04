import type { ModelUsage, SessionCost } from '@aic/ipc';

/**
 * Gemini API prices for cost estimates (paid tier, USD), from
 * https://ai.google.dev/gemini-api/docs/pricing, checked on PRICES_CHECKED.
 * Users pay Google directly with their own key; these only inform them.
 */
export const PRICES_CHECKED = '2026-11-04';

/** USD per 1M tokens. */
const TOKEN_PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gemini-3.5-flash-lite': { input: 0.3, cachedInput: 0.03, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, cachedInput: 0.025, output: 1.5 },
  'gemini-2.5-flash-lite': { input: 0.1, cachedInput: 0.01, output: 0.4 },
  'gemini-3.1-pro-preview': { input: 2, cachedInput: 0.2, output: 12 },
  'gemini-3.8-flash': { input: 0.75, cachedInput: 0.075, output: 3.75 },
};

/**
 * USD per minute of audio sent. For gemini-3.5-transcribe-live Google
 * estimates 25 audio tokens per second in and 175 text tokens per minute out:
 * about $0.009 per minute, blended.
 */
const TRANSCRIPTION_PER_MINUTE: Record<string, number> = {
  'gemini-3.5-transcribe-live': 0.009,
};

export function modelCostUsd(model: string, u: ModelUsage): number | null {
  const p = TOKEN_PRICES[model];
  if (!p) return null;
  const fresh = Math.max(0, u.inputTokens - u.cachedTokens) + u.estimatedInputTokens;
  return (fresh * p.input + u.cachedTokens * p.cachedInput + u.outputTokens * p.output) / 1e6;
}

/** An estimate of what a session cost on the user's key. */
export function estimateSessionCost(opts: {
  transcriptionModel: string;
  /** Seconds of audio sent for transcription, all channels. */
  audioSeconds: number;
  models: Record<string, ModelUsage>;
  /** Listening time, for the per-hour figure. */
  durationMs: number;
}): SessionCost {
  const perMinute = TRANSCRIPTION_PER_MINUTE[opts.transcriptionModel];
  const transcriptionUsd = perMinute === undefined ? null : (opts.audioSeconds / 60) * perMinute;
  let modelsUsd = 0;
  const unpriced: string[] = [];
  for (const [model, usage] of Object.entries(opts.models)) {
    const cost = modelCostUsd(model, usage);
    if (cost === null) unpriced.push(model);
    else modelsUsd += cost;
  }
  if (transcriptionUsd === null) unpriced.unshift(opts.transcriptionModel);
  const totalUsd = (transcriptionUsd ?? 0) + modelsUsd;
  const hours = opts.durationMs / 3_600_000;
  return {
    transcriptionUsd,
    modelsUsd,
    totalUsd,
    perHourUsd: hours >= 1 / 60 ? totalUsd / hours : null,
    unpriced,
    pricesChecked: PRICES_CHECKED,
  };
}
