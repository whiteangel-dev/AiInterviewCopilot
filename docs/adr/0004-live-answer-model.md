# ADR 0004 — Live answer model: `gemini-3.5-flash-lite`, implicit caching only

- **Status:** Accepted (2026-11-03)

## Context
Speed is the top technical priority, and answers must also be grounded.

## Evidence (Phase 0; 17 interview turns × 2 runs)
| Model | Time to first token, median / 95th pct | Notes |
|---|---|---|
| gemini-3.5-flash-lite (`MINIMAL`) | **528 / 717 ms** | Honest on the trap question; occasional small embellishments |
| gemini-3.8-flash (`thinkingBudget: 0`) | 1,901 / 5,031 ms | Slower and erratic |
| gemini-3.1-pro-preview (`LOW`) | 4,840 / 6,072 ms | Too slow for live use |

Caching, measured with a ~7.2k-token prompt:
- implicit caching: 555 ms median time to first token;
- explicit cache: 725 ms median, 1,467 ms at the 95th percentile — **slower**.

## Decision
- Default live answers: **`gemini-3.5-flash-lite`** with `MINIMAL` thinking.
- "Quality" preset: `gemini-3.1-pro-preview`.
- Use only Gemini's automatic (implicit) caching on the live path.
- Always pass today's date in the session context; without it, the models got job durations wrong.

## Consequences
- **A background fact check (Phase 5)** is needed for the small embellishments flash-lite makes.
- **Revisit explicit caching** for cost if knowledge bases grow large.
