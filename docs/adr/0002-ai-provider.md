# ADR 0002 — AI provider: Gemini first, behind interfaces; models are configuration

- **Status:** Accepted (2026-11-03)

## Context
- The user supplies a Gemini API key.
- The requirements ask for configurable AI providers.
- Google's model list changes often: the key could access 60 models during Phase 0.

## Decision
- Implement **Google Gemini first**, using `@google/genai`.
- All model access goes through `SttProvider` / `LlmProvider` interfaces, so OpenAI and Claude can be added as adapters.
- Model IDs are **settings**, discovered and validated through the Models API, not hard-coded.
- Thinking configuration is resolved per model: `thinkingLevel` or `thinkingBudget`, whichever the model accepts.

## Consequences
- **Swapping models or vendors** needs no code changes beyond an adapter.
- **Settings need a "test connection / list models" step.**
- **Benchmarks** in `spikes/` can be re-run to re-pick defaults whenever new models ship.
