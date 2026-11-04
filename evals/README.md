# Evaluations

Checks that call the real Gemini API with the production code: prompts, provider and the engine. They run only with `AIC_LIVE_TESTS=1`. The key comes from `.env.local` (`GEMINI_API_KEY`) and is never logged.

| Command | What it checks | Time · cost |
|---|---|---|
| `npm run eval:turns` | The turn analyzer on 49 probes from Phase 0:<ul><li>17 complete interviewer turns;</li><li>16 turns cut at mid-sentence pauses.</li></ul>Are questions answered, statements left alone, and mid-turn pauses not answered too early? | ~45 s · < 1 cent |
| `npm run eval:live` | The whole engine in real time on the 17 Phase 0 interviewer clips:<ul><li>last word → first answer word;</li><li>correct outcomes;</li><li>prints every answer for review.</li></ul>Needs `cd spikes && npm run gen-audio` once | ~2.5 min · ~1 cent |
| `AIC_LIVE_TESTS=1 npx vitest run --project @aic/evals models` | Each live model role answers once (Fast, Quality, analyzer) | ~10 s |

Fixtures: `spikes/src/fixtures/` (a fictional candidate, Jordan Rivera, interviewing at Kestrel Pay; questions; split turns). Results are saved to `evals/results/` (git-ignored). Summaries go in the phase reports, such as [docs/phase4/summary.md](../docs/phase4/summary.md).

Add `AIC_LIVE_VERBOSE=1` to see the engine's log. `AIC_EVAL_ANALYZER_MODEL=…` tries another analyzer model.
