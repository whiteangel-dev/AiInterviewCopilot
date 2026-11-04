# Phase 4 — Live answers (completed 2026-11-04)

**What changed:** the copilot now answers. When the interviewer finishes a question, an answer from your own experience appears in the copilot window about a second after their last word.
- **Format:** an opening sentence, then a few points in the order to say them.
- **Answer bank first:** approved answers from your answer bank appear instantly.
- **On request:** "Answer now", "Regenerate", "Shorter" and "Longer".
- **Saved:** every answer is kept with the session transcript.

Decisions: [ADR 0010](../adr/0010-live-answers.md).

**Still to confirm on your Windows PC:** real devices and real interviews (see [Try it](#try-it-on-your-windows-pc)). Everything below ran on recorded speech.

## What was built

| Area | What |
|---|---|
| Turn taking (`packages/core/src/live/turns.ts`) | The Phase 0 design, as a tested state machine:<ul><li>at a 300 ms pause: turn analyzer ∥ speculative answer;</li><li>re-run as the transcript catches up;</li><li>"?" fast path (withdrawn if the analyzer disagrees);</li><li>cancel when the interviewer resumes;</li><li>1.2 s fallback.</li></ul>Turn boundaries: answered, candidate spoke, or statement plus pause. Works without microphone transcription |
| Answers (`apps/desktop/src/engine/copilot.ts`) | Approved answer-bank matches shown instantly (no model call). Otherwise a streamed answer from the Fast (flash-lite) or Quality (Pro) model. Cache-friendly prompt: rules + session context → append-only interview history → latest turn |
| Prompts (`packages/prompts/src/live.ts`) | `live-answer@2` and `turn-analyzer@1`; history formatting; answer clean-up; a lenient verdict parser that reads the action from the stream |
| Provider | `streamText` for live calls: streamed text or JSON, per-model thinking-level fallback, a cached client per key, warm-up at interview start, time to first text and token counts |
| Copilot window | An answer card on top of the transcript:<ul><li>the question as understood, then the answer streaming in;</li><li>"Answer now", Shorter, Longer, Regenerate;</li><li>earlier answers one click away (‹ 2/5 ›);</li><li>"Listening…" / "Thinking…" status.</li></ul>The Interview page shows the same card |
| Interview setup | Company and role fields (used in answers, the title and the recognizer vocabulary) |
| Settings | "Answer automatically" (on by default). Shortcuts: Answer now (`Ctrl+Alt+Enter`), Regenerate (no default, because of AltGr layouts) |
| Sessions | Answers shown inline after each question, with a toggle; Copy and Save include them when shown; answer counts in the list |
| Data | Migration 4: `session_questions`, `session_answers` (text, status, latency, time to first text, tokens, model, prompt version). Turn counters in session stats. Answers left streaming by a crash are marked stopped |
| Evaluations (`evals/`) | Opt-in checks with real Gemini: turn analyzer (49 probes), the whole engine on 17 spoken questions, each live model role |

## Verification

| Check | Result |
|---|---|
| Unit tests | **172 pass** (Phase 3: 145). New:<ul><li>turn taking: 16 cases with a fake clock (re-runs, fast path and withdrawal, resume, fallback, turn boundaries, answer bank, Answer now, regenerate, errors, pause, missed voice activity, the not-transcribed reply);</li><li>prompts;</li><li>question and answer storage;</li><li>a full interview through the engine with recorded audio and the offline model: answers, regenerate, Answer now with automatic answers off, none during an audio test;</li><li>export with answers.</li></ul> |
| End-to-end (Playwright, built app) | **16 of 16 pass**: the 14 from earlier phases, plus:<ul><li>the copilot answers two questions, browse, Shorter, the same answers in the main window, answers saved with the session and hidden on request;</li><li>automatic answers off, then Answer now.</li></ul> |
| Turn analyzer, real Gemini | Questions answered at the end of the turn 30/30; statements and filler 3/3; answered early at a mid-turn pause 3/16 (Phase 0: 19%) |
| Whole engine, real Gemini | **17/17 correct** in 3 of 3 runs. Last word → first answer word **p50 1.15–1.36 s**, p95 1.44–1.87 s. Details below |
| Live model roles | Fast: first text 0.77 s. Quality: 4.8 s. Both honest on the Kubernetes trap question |

### The whole engine with real Gemini

The 17 Phase 0 interviewer clips play back to back in real time: replay → voice activity → Gemini Live transcription → turn analyzer ∥ answer → answer shown. The candidate is the Phase 0 fixture (Jordan Rivera, interviewing at Kestrel Pay).

| | Run 1 | Run 2 | Run 3 (final code) |
|---|---|---|---|
| Correct outcomes (15 questions answered, 2 statements left alone) | 17/17 | 17/17 | 17/17 |
| Withdrawn answers | 0 | 0 | 0 |
| Last word → first answer word, p50 / p95 | 1.15 / 1.44 s | 1.25 / 1.81 s | 1.36 / 1.87 s |
| Last word → answer request, p50 | – | – | 0.50 s |
| Model: request → first text, p50 | – | 0.65 s | 0.76 s |

**Why it's slower than Phase 0's prototype (0.97 s):**
- **The app's own part is steady:** about 0.5 s, the 300 ms pause plus the transcript catching up.
- **The rest is the model's time to first token, which varied a lot that day:** 0.45–2.0 s for the same short request (Phase 0: 0.53 s median).
- **Connections aren't the cause:** waiting 6 s between requests, or cancelling requests (as speculative attempts do), made no difference.

**Answer quality (run 3):**
- **Honest gaps:** "I haven't run Kubernetes in production, but…".
- **Salary:** follows the instruction to ask for their range first.
- **Accurate stories:** the incident, disagreement and memory-leak stories match the notes.
- **Questions to ask:** matches the notes.

### Problems found and fixed

| Problem | Fix |
|---|---|
| "Tell me about yourself" was answered with "I'm doing well, thanks…": with no transcribed reply in the history, the model answered the earlier small talk again | A rule to answer only the latest turn, and a `(answered; not transcribed)` reply in the history after an answered question |
| A late transcript from the candidate could split one question into two turns | Turn boundaries use the candidate's voice activity, not their transcript |
| Words flushed when pausing could start an answer attempt | Pause and resume are explicit in the turn taker |
| The first analyzer eval scored "ignore" at a mid-turn pause as a failure, though it shows nothing | The eval scores what users see: answers shown too early, and questions missed |

## Known limitations

- **Not yet run on real interviews:**
  - the pause lengths and the "?" fast path were tuned on clean synthetic speech;
  - each session now saves turn counters and per-answer timings, to tune with.
- **Early answers at ambiguous pauses** (a complete sentence, then more) happen in about 1 of 5 such pauses. The rest of the question becomes a follow-up with its own answer.
- **Cost:** about 2 analyzer and 2 answer calls per question (half cancelled), on top of transcription. Measuring the cost per interview hour is planned for Phase 5.
- **No fact check yet** (Phase 5). The grounding rules hold in the evals, but small embellishments are possible.
- **Quality mode** takes about 5 s to start an answer.

## Try it on your Windows PC

The same installer as Phase 3 ([steps](../phase3/summary.md#real-device-test-on-your-windows-pc)), from the latest CI run on `main`. After the audio test:

1. In **Profiles**, import your resume. In **Knowledge**, add notes about the company and role. In **Answer bank**, approve a few answers (optional).
2. In **Interview**, enter the company and role, choose the profile and notes, and press **Start listening**.
3. Play a mock-interview video (search YouTube for "software engineer mock interview"), or ask a friend to call you. The copilot should show an answer about a second after each question.
4. Try **Answer now** (`Ctrl+Alt+Enter`), **Shorter** and **Longer**. Afterwards, open the session in **Sessions**.
5. Tell me:
   - whether answers came too early (mid-question) or too late;
   - whether any answer said something that isn't true about you;
   - the result of **Copy diagnostics** if anything misbehaved.

## Re-run

```
npm test                                   # unit tests
npm run build && npm run test:e2e          # end-to-end (offline fakes)
npm run eval:turns                         # turn analyzer, real Gemini (~45 s)
npm run eval:live                          # whole engine, real Gemini (~2.5 min; needs: cd spikes && npm run gen-audio)
AIC_LIVE_TESTS=1 npx vitest run --project @aic/evals models
```
