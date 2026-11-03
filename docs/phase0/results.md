# Phase 0 — Results so far (2026-11-03)

Measured from the Linux dev machine's network. Fixtures: a fictional candidate (`spikes/src/fixtures/`), 17 interviewer turns, and synthetic interviewer audio from Gemini TTS (clean speech; real call audio is still to be tested).

## Speech-to-text: Gemini Live, `gemini-3.5-transcribe-live`

All 17 clips (128 s) were streamed at real-time pace in 20 ms chunks over one session, with English language set and profile terms passed as custom vocabulary.

| Silence before end of segment | First partial text after speech starts | Final transcript after speech ends | Mean WER |
|---|---|---|---|
| 500 ms | p50 544 ms · p95 991 ms | p50 910 ms · p95 1104 ms | 2.7% |
| **300 ms** | p50 554 ms · p95 979 ms | **p50 714 ms · p95 910 ms** | 2.7% |

- Partial text updates word by word (5–22 updates per utterance), so starting an answer early is possible.
- Nearly all of the word error rate is formatting ("twelve" → "12", "fifty thousand" → "50,000") and dropped filler words ("uh", "mm-hm").
- No voice-activity events or token usage were reported for this model. Cost needs checking on the pricing page.

## Answer generation: streaming `generateContent`, minimal thinking

Each request had a ~1.9k-token prompt (rules + profile + knowledge), with 17 turns × 2 runs per model.

| Model | Thinking setting accepted | TTFT p50 | TTFT p95 | Total p50 | Skip/answer correct |
|---|---|---|---|---|---|
| **gemini-3.5-flash-lite** | `thinkingLevel: MINIMAL` | **528 ms** | **717 ms** | 842 ms | 33/34 |
| gemini-3.8-flash | `thinkingBudget: 0` | 1901 ms | 5031 ms | 2625 ms | 34/34 |
| gemini-3.1-pro-preview | `thinkingLevel: LOW` | 4840 ms | 6072 ms | 5219 ms | 34/34 |

- **Provider cache hits: 0%.** A ~1.9k-token prompt is probably below Gemini's implicit-cache minimum. Re-test with a realistic, larger profile and with explicit caching (`--explicit-cache`).
- **Quality (flash-lite):** it handled the Kubernetes trap question honestly and followed the salary instruction partly. It made small embellishments (for example, put the Datadog alert at the wrong employer). This confirms the background fact check is needed.
- **Prompt fixes found:** pass today's date (otherwise durations are wrong); forbid invented small-talk details; require contractions.

## Estimated end-to-end time (interviewer stops → first answer words)

| Path | p50 | p95 |
|---|---|---|
| Early start: 300 ms local silence + partial text → flash-lite | ~0.85 s | ~1.0 s |
| Wait for final transcript → flash-lite | ~1.25 s | ~1.6 s |

Both meet the target of 1.5 s or less at the median.

## Provisional decisions (to confirm before Phase 1)

1. **STT:** `gemini-3.5-transcribe-live`, with 300 ms end-of-segment silence; turn detection merges segments.
2. **Live answers:** `gemini-3.5-flash-lite` as the default ("Speed" and "Balanced"). `gemini-3.1-pro` is available as a slower "Quality" option. `gemini-3.8-flash` isn't worth it: it's slower and less consistent than flash-lite.
3. **Model names are configuration, not code.** The app discovers available models through the Models API, because the model list changes often.

## Still to do in Phase 0

- [ ] Windows audio capture, Option A (`spikes/capture-win/`): run on a Windows PC (see its README).
- [ ] Windows audio capture, Option B (Rust napi-rs native module): needs a Rust toolchain.
- [ ] Transcription accuracy on real call audio (from the Option A recordings).
- [ ] Turn-detection prototype on audio with natural mid-sentence pauses.
- [ ] Question-analyzer latency and accuracy (flash-lite with structured output).
- [ ] Cache behavior with a realistic larger profile; cost per interview hour.

## Re-run

```
cd spikes
npm install
npm run models                 # what this key can access
npm run gen-audio              # synthetic interviewer clips
npm run bench:stt -- --vad-silence 300
npm run bench:llm -- --runs 2  # add --models a,b,c to compare others
```
