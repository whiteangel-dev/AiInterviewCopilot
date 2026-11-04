# ADR 0010 — Live answers: turn taking, answer writing, storage

- **Status:** Accepted (2026-11-04). Built in Phase 4 and measured with real Gemini on recorded speech. Still to be tuned on real interviews.

## Context
Phase 3 made the app listen: both sides transcribed live, shown in the copilot window. Phase 4 makes it answer: notice when the interviewer has asked something, and stream a short, grounded answer about a second after their last word.

The approach was designed and measured in Phase 0 ([ADR 0004](0004-live-answer-model.md), [ADR 0005](0005-end-of-turn-detection.md)). This ADR records how it was built into the app, and what changed on the way.

## Decision

### Turn taking (`packages/core/src/live/turns.ts`)
A state machine with no network or Electron code, fed by the live run: voice activity per channel, interim and final transcript, and a tick every 100 ms. The model calls are injected, so every timing path is unit-tested with a fake clock.

- **Attempts, as in Phase 0:**
  - The interviewer pauses (300 ms of silence on the voice detector): start an attempt, the turn analyzer ∥ a speculative answer.
  - The transcript grows during the pause: restart the attempt with the fuller text.
  - **"?" fast path:** a turn ending in "?" is shown as soon as the answer streams.
  - If the analyzer then says "wait" or "ignore", the answer is **withdrawn**: it disappears from the copilot and is counted.
  - The interviewer resumes: cancel the attempt.
  - **Fallback:** at 1.2 s of silence, once per pause, ask the analyzer again with a "silent for over a second" hint.
- **Turns.** A turn is the interviewer's speech since the last boundary. A new turn starts when the interviewer speaks:
  - after their previous turn was answered;
  - after the candidate spoke for 1 s or more (voice activity while the interviewer was silent; this works without microphone transcription, and echo doesn't count because it overlaps the interviewer);
  - after a finished statement ("ignore") followed by at least 1.5 s of silence;
  - after listening was paused and resumed.

  Otherwise their speech extends the current turn: a lead-in, a statement and then the question, or a mid-sentence pause, all stay together.
- **A turn answered early is not reopened.** When the analyzer answers at a pause and the interviewer then adds more ("…and why that design?"), the addition is a new turn. Its history holds the first part, so the analyzer marks it a follow-up and the new answer covers both parts.
- **Interviewer speech that voice detection missed** (very quiet audio) still counts: a final transcript with no voice activity is treated as the pause, about 0.7 s after the last word.

### Answers
- **The answer bank first.** If an *approved* prepared answer confidently matches the turn (the Phase 3 matcher), it is used as the attempt's answer: no model call, shown the moment the turn is confirmed. Drafts are no longer shown live; those questions get a live answer instead.
- **Prompt layout (cache-friendly).** The answer prompt has three parts:
  - **System instruction:** the rules, then the session context (SESSION with date, company and role; CANDIDATE PROFILE; CANDIDATE KNOWLEDGE). It is byte-identical for every request of a session at a given length.
  - **History:** "INTERVIEW SO FAR", append-only. It is trimmed from the front only past 24,000 characters, and then in one large step, so the prefix stays stable for Gemini's implicit caching.
  - **The latest turn:** "INTERVIEWER'S LATEST TURN".
- **Answer only the latest turn.** The model must not re-answer older questions. When a question was answered but no reply from the candidate was transcribed, the history shows the reply as `Candidate: (answered; not transcribed)`. Without that marker, the model reopened "Tell me about yourself" with "I'm doing well, thanks", answering the small talk again (found in the live eval).
- **Format:** the length preset's rules (Phase 2), plus: small talk in one or two sentences, and a one-sentence reply to a turn that asks nothing (for "Answer now").
- **Models:**
  - Fast: `answerFast`, minimal thinking.
  - Quality: `answerQuality`, low thinking.
  - Turn analyzer: `turnAnalyzer`, minimal thinking, JSON schema. The action is read from the stream as soon as it appears.
  - A model that rejects a thinking level falls back to the next one (minimal → low → none), remembered per model.
- **Display:** the analyzer must confirm (unless on the fast path), *and* the answer's first text must have arrived. The whole answer is re-sent as it streams. Labels and quotes the model adds anyway are cleaned off.
- **On request:**
  - **Answer now** (button; hotkey `Ctrl+Alt+Enter`): confirms the attempt in flight, or answers the current turn without the analyzer. With nothing new to answer, it rewrites the last answer.
  - **Regenerate, Shorter, Longer:** a new answer to the same question, with the same history snapshot, at another length if asked. The earlier answers stay one click away.
  - **"Answer automatically" setting:** off means answers appear only on request.
  - **The regenerate hotkey has no default:** `Ctrl+Alt+letter` is `AltGr+letter`, which types characters on many keyboard layouts.

### Storage and events
- **Tables:** migration 4 adds `session_questions` and `session_answers`.
  - `session_answers` holds the source, trigger, length, model, prompt version, text and status. It also records the latency (last word → first word shown), the model's time to first text, the duration and token counts.
  - Withdrawn answers are kept for tuning and hidden from the UI.
  - Session stats gain turn counters: attempts, cancelled, answered, ignored, withdrawn.
  - **Deviation from the plan:** there is no separate `latency_events` table. Each answer row already carries its timings.
- **Answers reach the windows through main (`live.answer`, `live.turn`)**, like the other live events ([ADR 0009](0009-live-listening.md)). An answer is about 10–30 updates of under 1 KB each, so the direct engine → renderer port is still not needed.
- **Sessions** show the answers inline, after the question they answered. Copy and Save include them when they are shown.

### Evaluations (`evals/`)
These are opt-in (`AIC_LIVE_TESTS=1`) and run against the real API with the production code and the Phase 0 fixtures:
- `turns`: the analyzer on 49 probes.
- `live-answers`: the 17 interviewer clips played in real time through the whole engine.
- `models`: each live model role answers once.

## Evidence (2026-11-04, Linux dev machine)

| Measurement | Result |
|---|---|
| Turn analyzer, 49 probes | Questions answered at the end of the turn **30/30**; statements and filler left unanswered 3/3. Answered too early at a mid-turn pause: 3/16, the same 19% as Phase 0 (complete sentences such as "Walk me through the incident."). Decision p50 778 ms (Phase 0: 606 ms) |
| Whole engine, 17 clips, real time (3 runs) | **17/17 correct outcomes** in every run, 0 withdrawn. Last word → first answer word: **p50 1.15 / 1.25 / 1.36 s**, p95 1.44 / 1.81 / 1.87 s |
| Where the time goes (last run) | Last word → answer request p50 0.50 s (300 ms pause plus the transcript catching up); request → first text p50 0.76 s |
| Model time to first text, same day | flash-lite 0.45–2.0 s (median ~0.7 s; Phase 0: 0.53 s). It doesn't change after 6 s idle or after cancelled requests, so connection reuse isn't the cause |
| Quality mode | `gemini-3.1-pro-preview`, low thinking: first text 4.8 s (Phase 0: 4.84 s) |
| Cost | About 2.1 attempts per question, about half cancelled. Each attempt is one analyzer call and one answer call (~2,300 input tokens) |

## Consequences
- **Speed meets the target (p50 ≤ 1.5 s) but is above Phase 0's 0.97 s.** The difference is the model's time to first token on the day; the app's own part is a steady ~0.5 s. Phase 5 can try:
  - starting speculative answers before the 300 ms pause;
  - a second provider for failover when Gemini is slow.
- **Early answers at genuinely ambiguous pauses (~19%)** become a first answer plus a follow-up answer. Tune on real interviews, with the counters now saved per session.
- **Speculation roughly doubles the model calls.** Flash-lite is cheap, but Phase 5 should measure the cost per interview hour, together with transcription.
- **Small embellishments** (Phase 0) are still possible. The Phase 5 background fact check can use the saved answers and context snapshot.
