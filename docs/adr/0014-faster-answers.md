# ADR 0014 — Faster answers on Windows

- **Status:** Accepted (2026-11-04). Built in Phase 7 (version 1.2.0).

## Context
Windows is the main platform, and answer speed there comes first. Before this phase, the time from the interviewer's last word to the first answer word was about 1.2–1.36 s at the median, with a tail up to 1.87 s. It splits into two parts:
- **The transcript catching up:** about 0.5 s;
- **Gemini's first text:** about 0.65 s.

## What was measured

| Question | Finding |
|---|---|
| When does the transcript hold the whole question? (`evals/stt-timing`) | At the local pause (300 ms after the last word), the last word or two are still missing in 14 of 17 questions. They arrive 0.46 s after the last word (median), in the in-progress transcript, before the final one |
| End the audio stream at the pause instead of 800 ms later? | The *final* transcript comes ~0.2 s sooner (median 0.57 s vs 0.78 s). But the in-progress updates stop, so the words are complete *later* (0.54 s vs 0.46 s). **Not adopted** |
| Two identical requests raced, first text wins | First text p50 0.51 s vs 0.53 s, **p95 0.66 s vs 0.89 s**, max 0.66 s vs 0.96 s |
| Restarts when the transcript changes | Some changes are punctuation only (the final adds "?"), and those restarted the answer |
| Questions without "?" ("Tell me about…") | These waited for the turn analyzer (another ~0.5 s) and made up the slow tail |

## Decision
1. **Race two requests from the start** for the answer and the turn analyzer. The first to show text wins; the other is cancelled.
   - A rate limit turns racing off for the rest of the session, falling back to a duplicate only when the first is slow (Phase 5). This protects Google's free-tier per-minute limits.
   - Cost: about $0.005 per question instead of $0.003, or about 5 cents more per interview hour.
2. **Keep the answer already being written when the transcript changes only in punctuation, case or spacing.** If the change adds "?", that confirms the answer.
3. **A second fast path, for finished requests:** the last sentence starts like a request ("Tell me about…", "Walk me through…", "Describe…", "Explain…", "Give me an example…", optionally after "So," or "Can you") and ends with a period. These are shown as soon as the answer streams, like a "?" question, and the analyzer can still withdraw them.
   - **Early-answer check (Phase 0's 16 mid-turn pauses):** it would show early at one pause, "Walk me through the incident.", where the analyzer already did. So it adds no early answers.
4. **The audio stream still ends 800 ms after the pause** (see the measurements).

## Evidence (whole engine, real Gemini, 17 spoken questions, two runs)

| | Phase 5 | Phase 7 |
|---|---|---|
| Last word → first answer word, p50 | 1.23 s | **1.02 s, 0.98 s** |
| p95 | 1.46 s | **1.34 s, 1.30 s** |
| Gemini first text, p50 | 0.63 s | 0.50 s |
| "Tell me about a time you had to deal with a major production incident." | 1.10–1.39 s | **0.82–0.83 s** |
| Correct outcomes | 17/17 | 17/17, 0 withdrawn |

## Consequences
- **The rest is mostly transcription:** about 0.46 s before the last words appear. A faster transcription model, or one that predicts the end of a sentence, would be the next big step.
- **More requests:** racing roughly doubles the answer and analyzer requests. Most are cancelled and cost little (input tokens only).
