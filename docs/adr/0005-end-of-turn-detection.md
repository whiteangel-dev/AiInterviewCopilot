# ADR 0005 — End-of-turn detection: VAD pause + analyzer ∥ speculative answer

- **Status:** Accepted (2026-11-03)

## Context
- Waiting for long silences is slow.
- Short silences cut interviewers off mid-sentence.
- Silence alone at 300 ms fired at 100% of mid-turn pauses; at 1.2 s it adds 1.2 s to every answer.

## Decision
1. **Start an attempt** when local voice detection sees a pause of 300 ms or more.
2. **Each attempt runs two calls at once:**
   - the turn analyzer: flash-lite with a JSON schema; `complete` and `action` come first so the decision can be read from the stream;
   - a speculative answer stream.
3. **Re-run the attempt whenever the interim transcript grows** during the pause; the transcript usually catches up after the pause begins.
4. **Fast path:** a transcript ending with "?" is shown as the answer streams; the analyzer can still retract it.
5. **Cancel** if the interviewer resumes, or if the analyzer says "wait" or "ignore".
6. **Fallback** at 1.2 s of silence: run the analyzer again with a "silent for over a second" hint.

## Evidence (Phase 0)
| Measurement | Result |
|---|---|
| Analyzer decision | 606 ms median; 97% action accuracy; 98% follow-up detection |
| End-to-end prototype, 17 turns | **0.97 s median / 1.24 s at the 95th percentile**, last word → first answer word |
| Outcomes | 17/17 correct; 0 answers shown too early |
| Cost | ~2 model calls per turn |

## Consequences
- Answers to turns that are genuinely ambiguous (a complete sentence followed by more) sometimes start early and get cancelled. This is invisible to the user and costs a few cheap tokens.
