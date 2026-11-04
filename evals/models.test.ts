/**
 * Checks that each live model role answers through the production provider,
 * with the thinking setting it uses in the app: the turn analyzer and Fast
 * answers (minimal thinking), Quality answers (brief thinking). One request each.
 */
import { GeminiProvider } from '@aic/core';
import { DEFAULT_MODELS } from '@aic/ipc';
import {
  TURN_ANALYZER_SYSTEM,
  TURN_VERDICT_SCHEMA,
  buildSessionContext,
  liveAnswerInput,
  liveAnswerSystem,
  parseTurnVerdict,
  turnAnalyzerInput,
} from '@aic/prompts';
import { describe, expect, it } from 'vitest';
import { API_KEY, loadKnowledgeNotes, loadProfileBrief, ms, report } from './lib';

const context = () =>
  buildSessionContext({
    today: '2026-11-04',
    company: 'Kestrel Pay',
    role: 'Senior Backend Engineer, Ledger team',
    brief: loadProfileBrief(),
    knowledge: loadKnowledgeNotes(),
  }).text;

describe.skipIf(!API_KEY)('live model roles (real Gemini)', () => {
  const provider = new GeminiProvider();

  it('turn analyzer', async () => {
    const res = await provider.streamText({
      apiKey: API_KEY!,
      model: DEFAULT_MODELS.turnAnalyzer,
      system: TURN_ANALYZER_SYSTEM,
      text: turnAnalyzerInput({
        recent: '',
        turn: 'What drew you to payments?',
        longSilence: false,
      }),
      schema: TURN_VERDICT_SCHEMA,
      thinking: 'minimal',
      maxOutputTokens: 300,
      task: 'turn-analyzer',
    });
    report(`turn analyzer ${res.model}: first text ${ms(res.firstTextMs ?? NaN)}`);
    expect(parseTurnVerdict(res.text)?.action).toBe('answer');
  }, 60_000);

  for (const [role, model, thinking] of [
    ['Fast', DEFAULT_MODELS.answerFast, 'minimal'],
    ['Quality', DEFAULT_MODELS.answerQuality, 'low'],
  ] as const) {
    it(`${role} answers`, async () => {
      const res = await provider.streamText({
        apiKey: API_KEY!,
        model,
        system: liveAnswerSystem({ length: 'standard', context: context() }),
        text: liveAnswerInput({
          history: '',
          turn: 'Have you worked with Kubernetes in production?',
        }),
        thinking,
        maxOutputTokens: thinking === 'low' ? 4096 : 1024,
        task: 'live-answer',
      });
      report([
        `${role} ${res.model}: first text ${ms(res.firstTextMs ?? NaN)}, total ${ms(res.durationMs)}, ${res.inputTokens} in / ${res.outputTokens} out`,
        ...res.text.split('\n').map((l) => `  ${l}`),
      ]);
      expect(res.text.trim().length).toBeGreaterThan(20);
      // The fixture candidate has never run Kubernetes in production.
      expect(res.text).toMatch(/haven't|have not|not in production|never/i);
    }, 120_000);
  }
});
