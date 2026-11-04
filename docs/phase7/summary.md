# Phase 7 — Faster answers on Windows (completed 2026-11-04)

**What changed:**
- **Typical answer:** appears about **1.0 s** after the interviewer's last word (was 1.2–1.36 s).
- **Slowest answers:** about 1.3 s (were up to 1.87 s).

Decisions: [ADR 0014](../adr/0014-faster-answers.md).

## What was built

| Change | Why |
|---|---|
| Two identical requests race; the first to answer wins | Gemini's first-word time varies a lot; the faster of two is more consistent (p95 0.66 s instead of 0.89 s). Turned off for the session after a rate limit |
| An answer in progress is kept when the transcript only gains punctuation | Before, the final transcript adding "?" restarted the answer |
| "Tell me about…" requests are shown as fast as "?" questions | These used to wait ~0.5 s for the analyzer; they were the slowest answers |
| `evals/stt-timing` | Measures when the transcript holds the whole question. Showed that ending the audio stream early would make things slower |

## Verification

| Check | Result |
|---|---|
| Unit tests | **210 pass**:<ul><li>racing and rate limits;</li><li>an answer kept on punctuation changes;</li><li>request detection: finished requests vs lead-ins and statements.</li></ul> |
| End-to-end | **20 of 20 pass** |
| Whole engine, real Gemini, 2 runs | p50 **1.02 s / 0.98 s**, p95 **1.34 s / 1.30 s**, 17/17 correct, none withdrawn. The two "Tell me about…" questions take 0.82–1.02 s (were 1.10–1.66 s) |
| Cost | Model calls about $0.005 per question (was $0.003). About $0.61 per interview hour in total (estimated) |

## Where the time goes now
- **About 0.5 s for the transcript** to contain the last words. This is the speech recognizer, so it can only shrink with a faster recognizer.
- **About 0.5 s for Gemini's first words.**
