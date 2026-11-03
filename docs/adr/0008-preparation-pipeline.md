# ADR 0008 — Preparation pipeline: resume extraction, knowledge, answer bank

- **Status:** Accepted (2026-11-03)

## Context
Phase 2 turns a resume and free-form notes into what live answers will rely on. The product's rule is "never fabricate experience", so every step is built to keep the model honest and to make its mistakes visible to the user.

## Decision

### Resume
- **Text is extracted locally:** pdf.js through `unpdf` for PDF, and our own small OOXML reader for `.docx`. Old `.doc` files are refused with a clear message.
- **The model reads the original file.** PDFs go to Gemini as PDFs, so layout and scanned pages work. Word files go as the extracted text.
- **Every highlight and achievement comes with a verbatim quote.** The engine looks for it in the local text by comparing word tokens:
  - ligatures, dashes, quotes and line breaks are normalized;
  - up to 15% of words may be missing;
  - every number must match exactly.
- **Each statement gets a status:**
  - `verified` or `unverified`, depending on whether the quote was found;
  - `unchecked` when there's no text layer;
  - `inferred` for interpretations such as strengths;
  - `user` once the user edits it.
- **The UI flags unverified statements** for review.
- **Profiles are immutable versions:** extracted, edited, or restored. Each stores the model, the prompt version, its duration and its token counts.
- **The Candidate Brief is compiled deterministically** from the profile, with no model involved. It can't invent anything, and the same profile always gives the same bytes, which helps prompt caching.

### Application Knowledge
- **Notes are items**, each a `fact` or an `instruction`, in 8 categories, grouped into knowledge bases (for example, one per application).
- **AI is used for two optional jobs:**
  - splitting pasted notes into items, which the user reviews before saving;
  - reviewing the notes, optionally against a resume profile, for duplicates, conflicts, unclear items, misfiled items and risky instructions.
- **Analyses store a hash of the items**, so the UI can show when a review is out of date.
- **The knowledge block is compiled deterministically:** instructions first, then facts by category.

### Answer bank
- **The model drafts answers** for common questions plus role-specific ones that the profile and notes can support.
- **Drafts need the user's approval.**
- **Matching is local and lexical:** stopwords removed, light stemming, Dice overlap against the question and 2–4 variants. It runs in microseconds with no network. A confident match is ≥ 0.6. Embeddings can come later if lexical matching proves too narrow on real interviews.

### Shared
- **Prompts and model output schemas live in `@aic/prompts`, with versions.**
- **Zod schemas are converted to the JSON Schema** Gemini's structured output takes.
- **Replies are validated again with Zod,** and a malformed reply is retried once.
- **Temporary failures are retried:** server errors (5xx) and network errors, up to 2 retries with backoff. Rejected keys and quota errors are not.
- **Long jobs report progress and can be cancelled.** The caller picks the job ID.
- **Grounding rules for the answer bank, which Phase 4 will reuse for live answers:**
  - no plausible-sounding details beyond what the profile says;
  - no instruction overrides grounding;
  - a final check of every specific against the profile and notes;
  - numbers as digits.
- **Preparation uses the Pro model by default.** `gemini-3.5-flash` was 2.4× faster but embellished more (see [results](../phase2/summary.md)).
- **Deleting a profile or knowledge base deletes everything under it.**
  - There are no soft deletes, and `secure_delete` is on.
  - Phase 3 sessions will keep a snapshot of the context they used, so they don't depend on these rows.

## Consequences
- **Mistakes are visible.** Unverified statements are highlighted before they can reach an answer, and risky notes are caught in review.
- **Some embellishment risk remains in generated answers** (for example, attributing a language to a tool when the resume doesn't say). That's why answers start as drafts, and why Phase 5 adds an automatic fact check.
- **Resumes go to Google.** Gemini receives the resume file; the UI says so before upload.
