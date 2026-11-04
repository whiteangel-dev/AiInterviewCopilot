# Phase 5 — Hardening (completed 2026-11-04)

**What changed:** the copilot is steadier, more honest and cheaper.
- **Steadier speed:** slow answers are rescued by a duplicate request, and a backup model takes over when Gemini errors.
- **Fact check:** each answer is checked against your profile and notes, and anything they don't support is marked before you say it.
- **Speakers:** with speakers instead of headphones, the interviewer's voice is removed from your microphone.
- **Cheaper:** only speech is sent for transcription, which roughly halves the cost of an interview hour. Each session shows its estimated cost.

Decisions: [ADR 0011](../adr/0011-hardening.md).

**Still to confirm on your Windows PC:** echo cancellation with real laptop speakers. It was measured with real speech through a simulated room.

## What was built

| Area | What |
|---|---|
| Duplicate and backup requests (`packages/core/src/live/hedge.ts`) | No text from a live request after ~the session's 90th-percentile wait (0.8–1.6 s): a duplicate goes out and the first to answer wins. A failure before any text (rate limit, server error, network): the backup model (`gemini-3.1-flash-lite`, a new "Backup for live answers" role) at once. Used for answers and the turn analyzer |
| Fact check (`packages/prompts/src/fact-check.ts`) | After each generated answer, the "Fact check" model (`gemini-3.5-flash-lite`) lists statements the profile and notes don't support, as exact quotes. The copilot underlines them, explains why, and shows "Checking…", "Checked" or "N to check". Saved with the answer (migration 5), shown in Sessions. Settings → Answers → Fact check |
| Echo cancellation (`packages/core/src/audio/aec.ts`) | An adaptive filter learns the echo path from the interviewer's audio to your microphone and removes it. It is paused while you talk over the interviewer, and a residual suppressor cleans up what's left. Voice detection and transcription hear the cleaned microphone. Audio → Echo cancellation (on by default) |
| Speech-only transcription | Audio goes to Gemini only around speech (400 ms before, 800 ms after), then the stream is ended. 100 ms of silence every 15 s keeps an idle connection open (the service closes it after ~60 s without audio) |
| Cost | Every live request is counted per model (tokens, cancelled requests, duplicates, fallbacks). Sessions shows an estimated cost from published prices (checked 2026-11-04) |
| Evaluations (`evals/`) | Added:<ul><li>`fact-check`: 33 answers, 18 with a planted untrue claim;</li><li>`echo`: an interview on simulated speakers, cancellation off vs on.</li></ul>`live-answers` now also reports the fact check, requests, audio sent and cost |

## Verification

| Check | Result |
|---|---|
| Unit tests | **194 pass** (Phase 4: 172). New:<ul><li>duplicate and backup requests (8);</li><li>echo cancellation and FFT (6): removal, the candidate passing through, double talk, a microphone ahead of the reference, no stalls;</li><li>speech-only transcription and keep-alive (3);</li><li>the fact check prompt and quote matching (3);</li><li>an interview through the engine with the fact check, usage and cost (2).</li></ul> |
| End-to-end (Playwright, built app) | **18 of 18 pass**: the 16 from earlier phases, plus:<ul><li>a flagged answer is underlined in the copilot with "1 to check", and the session shows the issue and its cost;</li><li>the new settings.</li></ul> |
| Whole engine, real Gemini, 17 spoken questions | **17/17 correct**, 0 withdrawn. Last word → first answer word **p50 1.23 s, p95 1.46 s**; Phase 4's slowest-answer figure (p95) was 1.44–1.87 s |
| Fact check, real Gemini | **17/18 planted claims caught, 0/15 false alarms** on grounded answers, 0.87 s median. In the live run it flagged 3 real small embellishments the answer model made |
| Echo, real Gemini | Interviewer words in the candidate transcript: 6 → 1 (only "Hi Jordan." before the filter had learned). The candidate's answer was transcribed word for word either way |

### Probes that shaped the design

| Question | Finding |
|---|---|
| Are slow answers caused by reconnecting? | No. A request after 6 s idle, or right after cancelled requests, isn't slower. The model's own time to first text varies (0.45–2 s) |
| Which backup? | `gemini-3.1-flash-lite`: p50 0.88 s (primary 0.64 s). Not `gemini-2.5-flash-lite`, which Google routes to the primary model from December 1 |
| Does a Live connection survive silence? | Without audio, it's closed after ~60 s. With 100 ms of silence every 15 s, it survived 3 minutes and transcribed the next question normally |
| Which fact-check model? | flash-lite caught as many as gemini-3.8-flash, about 3× faster |

### Problems found and fixed

| Problem | Fix |
|---|---|
| Echo cancellation learned almost nothing: the double-talk detector mistook loud echo for the candidate, and a too-eager divergence check kept resetting the filter | Double talk is judged from the leftover echo once the filter has learned (only obvious cases before). Divergence is judged over ~0.5 s |
| The canceller's leakage estimate was 10× too high, so its "learned" test never passed | Estimated from running sums over blocks where echo can be present (the whole filter window, not the lookahead block) |
| Slow learning | Step 0.7 and a 256 ms window (was 0.3 and 384 ms): 33 dB within ~1.5 s |

## Cost of an interview hour (estimate)

| | Before Phase 5 | Now |
|---|---|---|
| Transcription (both channels, $0.009 per minute sent) | 120 min sent: about $1.08 | about 54 min sent (speech plus padding): about **$0.49** |
| Answers, turn analysis, fact check (~25 questions × ~$0.003 measured) | about $0.07 | about **$0.08** |
| **Total** | about $1.15 | about **$0.57** |

**Assumptions:**
- the interviewer speaks 15 minutes and you speak 35;
- prices are from Google's pricing page on 2026-11-04;
- each session shows its own estimate, from what it actually sent;
- your Google bill is the authority.

## Known limitations

- **Echo cancellation hasn't met real speakers.** Laptop speakers distort, and rooms are noisier than the simulation. Its statistics are in "Copy diagnostics". Headphones remain the best setup.
- **While the canceller is still learning (about the first second),** a little echo can reach the transcript. The Phase 3 duplicate-line filter is still in place.
- **The fact check can miss soft claims.** It missed "I've been following Kestrel Pay" (1 of 18 planted claims). It doesn't hold the answer back, so a flag can arrive about a second after the answer.
- **No second provider yet** (OpenAI or Claude). It can join the fallback list once you have a key for it.
- **Gemini reported no cached input tokens** for these prompts, so caching isn't saving money yet.

## Try it on your Windows PC

The same installer as before, from the latest CI run on `main` ([Phase 3 steps](../phase3/summary.md#real-device-test-on-your-windows-pc)). In addition to the Phase 4 checks:

1. Run a mock interview **without headphones** on laptop speakers. Your transcript ("You") should not repeat the interviewer, apart from maybe the first second.
2. Look for underlined phrases in answers. If one is wrong, or an untrue claim wasn't underlined, tell me.
3. Afterwards, open the session in **Sessions** to see its estimated cost.
4. Send **Copy diagnostics** if anything misbehaves. It now includes the echo canceller's statistics.

## Re-run

```
npm test                                   # unit tests
npm run build && npm run test:e2e          # end-to-end (offline fakes)
npm run eval:live                          # whole engine, real Gemini (~2.5 min)
AIC_LIVE_TESTS=1 npx vitest run --project @aic/evals fact-check   # ~1 min per model
AIC_LIVE_TESTS=1 npx vitest run --project @aic/evals echo         # ~2 min
```
