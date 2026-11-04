# ADR 0011 — Hardening: hedged requests, fact check, echo cancellation, speech-only transcription

- **Status:** Accepted (2026-11-04). Built in Phase 5 and measured with real Gemini. Echo cancellation was measured on simulated room echo with real speech; real speakers are still to be tried.

## Context
Phase 4 left four things to harden:
- **Slow responses:** the model's time to first token varied from 0.45 s to 2 s for the same request, which stretched the slowest answers.
- **Embellishments:** small ones were still possible (Phase 0 found one).
- **Speakers:** without headphones, the microphone transcribed the interviewer.
- **Cost:** transcription streamed both channels the whole time, silence included.

## Decision

### Duplicate requests when slow; a backup model on failure (`packages/core/src/live/hedge.ts`)
- **Duplicate when slow:** a live request (answer or turn analyzer) with no text after the session's ~90th-percentile wait (learned per session, 0.8–1.6 s, 1 s at first) gets a duplicate to the same model.
  - The first to show text wins; the other is cancelled.
  - Only the winner's text reaches the screen, so two answers never mix.
- **Backup on failure:** a request that fails before any text goes straight to the backup model.
  - The failures that switch: rate limit, server error, network, model unavailable.
  - The backup is the new **"Backup for live answers"** role, `gemini-3.1-flash-lite`, on purpose a different model, so one rate limit or outage doesn't hit both.
  - Measured first-text time: p50 0.88 s, against 0.64 s for `gemini-3.5-flash-lite`.
  - Quality-mode answers fall back to the Fast model, then the backup. They get no duplicate, because they take about 5 s anyway.
- **Not retried:**
  - a failure after text was shown, because the answer would start over;
  - a bad key or a cancellation.
- **Considered and ruled out:**
  - `gemini-2.5-flash-lite` as the backup: Google routes it to `gemini-3.5-flash-lite` from 2026-12-01.
  - Connection reuse (keep-alive) as the cause of slow responses: requests after 6 s idle, or right after cancelled requests, weren't slower.

### Background fact check (`packages/prompts/src/fact-check.ts`)
- **When:** after a generated answer finishes, the new **"Fact check"** role (`gemini-3.5-flash-lite`, minimal thinking) compares it with the session context. Answer-bank answers are skipped, because the user approved them.
- **What it flags:** statements about the candidate that the profile and notes don't support, as exact quotes with a short reason and what the notes say instead.
- **What it accepts:** durations computed from dates, general technical explanation, and questions for the interviewer.
- **Quotes are checked locally:** a quote that isn't found in the answer is dropped. Matching ignores case, curly quotes and spacing.
- **In the copilot:** flagged words are underlined, with "Not in your profile or notes" and the reason underneath. The footer shows "Checking…", "Checked" or "N to check". The result is saved with the answer (migration 5) and shown in Sessions.
- **Off the critical path:** the answer isn't held back for the check. The check takes about 0.85 s, while the candidate is starting to read.
- **On by default;** it can be turned off in Settings → Answers.

### Echo cancellation (`packages/core/src/audio/aec.ts`)
Without headphones, the microphone hears the interviewer through the speakers. The interviewer channel (system loopback) is the reference.
- **Adaptive filter:** a partitioned-block frequency-domain adaptive filter (overlap-save NLMS), with:
  - 16 ms blocks;
  - 16 partitions, covering an echo delay from 64 ms before the reference (capture timing can put the microphone ahead) to 192 ms after;
  - step 0.7;
  - one partition constrained per block. Constraining all of them every block measured the same, at 16× the cost.
- **Double talk:** adaptation pauses while the candidate talks over the interviewer.
  - Once the filter has learned the echo: the residual is more than 4× the expected leftover echo and a real share of the microphone signal.
  - Before that: the microphone is louder than the reference.
  - "Talking over" that lasts more than 3 s is treated as a changed echo path, and the filter adapts.
- **Recovery:** a filter that keeps making things worse resets. The window follows slow clock drift by moving when the learned echo nears either end.
- **Residual suppressor:** a broadband gain turns down what the filter leaves while only the interviewer talks, with the leftover echo over-estimated 2×. The candidate's own speech is far louder than the residual and passes.
- **Lessons from measuring:**
  - an amplitude-only (Geigel) double-talk detector stopped adaptation on loud echo;
  - a leakage estimate averaged per block was wrong by 10×;
  - "is the interviewer talking" must look at the whole filter window, not the lookahead block.
- **What it touches:** voice detection and transcription hear the cleaned microphone. The level meter and the "use headphones" warning keep the raw one.
- **Cost:** the output lags by ~70 ms, on the candidate channel only, so answer speed is unaffected. CPU cost is small: five 512-point FFTs per 16 ms block.
- **On by default** (Audio → Echo cancellation). With headphones it learns nothing and passes the microphone through.

### Speech-only transcription (`packages/core/src/stt/gemini-live.ts`)
- **Billing:** Google bills Live transcription per second of audio sent (25 tokens/s; about $0.009 per minute blended), silence included.
- **The gate:** audio goes to transcription only around speech, using the local voice detector:
  - 400 ms of audio from before the speech;
  - the speech;
  - 800 ms after it (the service needs 300 ms of silence to finish an utterance);
  - then `audioStreamEnd`.
- **Keep-alive:** a probe showed the service closes a connection after **~60 s without audio** (close 1008). So an idle stream gets 100 ms of silence every 15 s. A probe confirmed the connection survives 3 minutes this way, and the next question was transcribed normally.
- **Reconnects:** buffering during a reconnect keeps only gated audio.

### Cost tracking (`packages/core/src/providers/metered.ts`, `pricing.ts`)
- **Counting:** every live request is counted per model:
  - requests and cancelled requests;
  - reported input, cached and output tokens;
  - estimated input for cancelled requests, which report no usage, counted as billed so estimates err high.
- **Session stats:** gain `usage` (also hedges and failovers) and the transcription model.
- **Estimate:** Sessions shows an estimated cost from a price table checked 2026-11-04. It names any model whose price isn't known.

## Evidence (2026-11-04, Linux dev machine, real Gemini)

| Measurement | Result |
|---|---|
| Whole engine, 17 spoken questions | **17/17 correct**, 0 withdrawn. Last word → first answer word **p50 1.23 s, p95 1.46 s**. Phase 4: p95 1.44–1.87 s across runs. 1 duplicate request sent |
| Fact check, 33 answers (15 grounded, 18 with a planted claim, 5 of them subtle ones from real model answers) | `gemini-3.5-flash-lite`: **17/18 caught, 0/15 false alarms**, p50 0.87 s. `gemini-3.8-flash`: no better on the first 26, p50 2.4 s, p95 8.9 s |
| Fact check in the live run | Flagged 3 of 15 real answers, all genuine small embellishments ("every deploy goes through our Replay load test", "made memory profiling part of our local load testing") |
| Echo, real speech through a simulated room (50 ms delay, a tail, 10 dB down) | Off: the interviewer's first question was transcribed as the candidate. On: only "Hi Jordan." (the first second, while the filter learned). The candidate's answer was transcribed word for word either way. 32 dB from the filter, 47 dB in total |
| Echo, synthetic (unit tests) | 33 dB within ~1.5 s. During double talk the candidate passes at −0.5 dB (correlation 0.99 vs 0.90 raw). No false double-talk without the candidate |
| Speech-only transcription | Live run: 92 s sent of 134 s listened (back-to-back questions). Echo run, microphone: 29 s sent without cancellation, 12 s with it, of 48 s |
| Cost of model calls | About **$0.003 per answered question**: analyzer and answer attempts (about half cancelled), the fact check and duplicates. 86 requests for 15 answers |

**Estimated cost of a one-hour interview:**
- **Assumptions:** 25 questions; the interviewer speaks 15 minutes and the candidate 35; padding about 4 minutes.
- **Transcription:** about 54 minutes sent, about **$0.49**. Before this phase: 120 minutes, $1.08.
- **Models:** about **$0.08**.
- **Total:** about **$0.57 per interview hour, down from about $1.15**.
- **Caveat:** these are estimates from published prices; the user's Google bill is what counts.

## Consequences
- **Real speakers are untested.** The echo canceller was built and measured on simulated echo. Laptop speakers add distortion and noise, so it needs a real-device test; the turn counters and canceller statistics are in "Copy diagnostics".
- **The first ~1 s of echo** can still reach the transcript while the filter learns (the transcript-level echo filter from Phase 3 remains as a backstop).
- **Gemini reported no cached tokens** for these prompts, so implicit caching isn't saving anything yet. Cancelled requests are ~40% of input tokens. Both are worth revisiting if cost matters more than speed.
- **A second provider** (OpenAI or Claude) can join the fallback list behind the same provider interface once a key is available.
