# Phase 0 — Results (completed 2026-11-03)

**Exit criterion met:** the end-to-end prototype gets from the interviewer's last word to the first answer word in **0.97 s median, 1.24 s at the 95th percentile** (target: 1.5 s or less at the median).

Measured from the Linux dev machine's network. Fixtures: a fictional candidate (`spikes/src/fixtures/`), 17 interviewer turns plus 16 turns split at mid-sentence pauses, and synthetic interviewer audio from Gemini TTS (clean speech). Real call audio comes in Phase 3. Decisions: [ADRs](../adr/).

## 1. End-to-end prototype (`npm run e2e`)

The audio is streamed in real time and goes through the full pipeline: local VAD (300 ms pause) → Live transcription → turn analyzer ∥ speculative answer. The answer is shown only when confirmed, and cancelled on "wait", "ignore", or when the interviewer resumes.

| Version | Last word → first answer word | Correct outcome | Answers shown too early |
|---|---|---|---|
| v1: one attempt per pause, 1.2 s fallback | p50 1,893 ms · p95 2,162 ms | 17/17 | 0 |
| **v2: + re-run when the transcript grows, + "?" fast path** | **p50 971 ms · p95 1,241 ms** | **17/17** | **0** |

- **Why v1 was slow:** at the 300 ms pause, the transcript was still missing the last words (it arrives ~0.5–0.8 s after speech ends), so the analyzer correctly said "wait".
- **Cost:** about 2 model calls per turn, about half of them cancelled.

## 2. Speech-to-text: `gemini-3.5-transcribe-live`

| End-of-segment silence | First partial text after speech starts | Final transcript after speech ends | Mean WER |
|---|---|---|---|
| 500 ms | p50 544 ms · p95 991 ms | p50 910 ms · p95 1,104 ms | 2.7% |
| **300 ms** | p50 554 ms · p95 979 ms | **p50 714 ms · p95 910 ms** | 2.7% |

- **Partial text** updates word by word and holds the whole utterance so far.
- **Errors** are almost all formatting ("twelve" → "12") and dropped filler words.
- **Not reported** by this model: voice-activity events and token usage. Cost is still to be confirmed.

## 3. Answer generation (17 turns × 2 runs, ~1.9k-token prompt)

| Model | Thinking | TTFT p50 | TTFT p95 | Total p50 | Skip/answer correct |
|---|---|---|---|---|---|
| **gemini-3.5-flash-lite** | `MINIMAL` | **528 ms** | **717 ms** | 842 ms | 33/34 |
| gemini-3.8-flash | budget 0 | 1,901 ms | 5,031 ms | 2,625 ms | 34/34 |
| gemini-3.1-pro-preview | `LOW` | 4,840 ms | 6,072 ms | 5,219 ms | 34/34 |

**Quality (flash-lite):**
- **Honest on the Kubernetes trap question.**
- **Followed the salary instruction only partly.**
- **Small embellishments.** For example, it put a monitoring alert at the wrong employer, which confirms the need for a background fact check.
- **Prompt fixes applied:** pass today's date, forbid invented small-talk details, require contractions.

## 4. Caching (flash-lite, 17 turns, ~7.2k-token prompt)

| Mode | Cached share | TTFT p50 | TTFT p95 |
|---|---|---|---|
| Implicit (automatic) | 9% | **555 ms** | 733 ms |
| Explicit cache | 99% | 725 ms | 1,467 ms |

Prompt size barely affects flash-lite's speed (1.9k → 7.2k tokens: 528 → 555 ms). Explicit caching is slower, so the live path uses implicit caching only.

## 5. Turn analyzer (`npm run bench:turns`, flash-lite, 49 probes × 2)

| Decision ready p50 / p95 | Turn ends → complete | Mid-turn pauses → wait | Action correct | Follow-up correct |
|---|---|---|---|---|
| 606 / 776 ms | 97% | 81% | 97% | 98% |

| End-of-turn policy | Cuts in early at mid-turn pauses | End detected after p50 |
|---|---|---|
| Silence only, 300 ms | 100% | 300 ms |
| Silence only, 700 ms | 69% | 700 ms |
| Silence only, 1,200 ms | 0% | 1,200 ms |
| **300 ms + analyzer** | **19%** (all genuinely ambiguous) | 903 ms |

## 6. Native audio module (Option B, `spikes/native-audio`)

| Check | Result |
|---|---|
| Frame assembler unit tests (passthrough, 48 kHz stereo float → 16 kHz, 8 kHz upsampling, chunk-boundary invariance) | 4/4 pass |
| `cargo clippy` for Linux and for `x86_64-pc-windows-msvc` (WASAPI code) | Clean |
| Node smoke test (test tone through napi → JS) | 51 frames/s, max gap 20.9 ms, level −12 dBFS, contiguous sequence |
| Windows build + load in CI | **Pass**: MSVC build, Node load, smoke test on `windows-latest` ([run](https://github.com/whiteangel-dev/AiInterviewCopilot/actions/runs/41584452723)) |
| **Real Windows devices** (mic, loopback, per-app) | **Not yet run. Moved to Phase 3, task 1** |

## Carried into later phases

- **Phase 3:**
  - real-device Windows capture tests (`spikes/capture-win` and `spikes/native-audio/smoke.mjs`);
  - transcription accuracy on real call audio;
  - Live session limits for long interviews;
  - transcription cost per hour.
- **Phase 4:** turn-detection tuning on real interviews (pause lengths, the "?" fast-path risk).
- **Phase 5:** background fact check for embellishments; explicit caching for cost on large knowledge bases.

## Re-run

```
cd spikes && npm install
npm run models                         # what the key can access
npm run gen-audio                      # synthetic interviewer clips
npm run bench:stt -- --vad-silence 300
npm run bench:llm -- --runs 2          # --models a,b  --context-copies 4  --explicit-cache
npm run bench:turns -- --runs 2
npm run e2e                            # full pipeline, last word → first answer word

cd native-audio && npm run build && npm run smoke   # needs Rust; on Windows also captures real devices
```
