# Phase 2 — Resume, Application Knowledge, answer bank (completed 2026-11-03)

**Result:**
- **Resume:** you can import a PDF or Word resume and review a structured profile. Every statement is checked against the resume.
- **Application Knowledge:** you can keep notes, have AI split and review them, and preview exactly what the answer model will see.
- **Answer bank:** you can prepare answers, approve them, and test which one a question would match.

Decisions: [ADR 0008](../adr/0008-preparation-pipeline.md).

## What was built

| Area | What |
|---|---|
| Resume import | PDF and `.docx` (≤ 10 MB) by drag and drop or file picker. Local text extraction; old `.doc`, empty and other files refused with a clear message; scanned PDFs handled (Gemini reads the page images) |
| Profile | Name, headline, experience, projects, skills, education, certifications, achievements, strengths, languages. Each statement shows where it comes from (from resume / not found / not checked / interpretation / edited) |
| Review and edit | Inline editor with a banner for statements not found in the resume; saving creates a new version; History with restore; re-analyze; "What the AI sees" (the compiled brief); the extracted resume text |
| Application Knowledge | Knowledge bases with fact and instruction notes in 8 categories; add, edit, delete; "Add from text" (AI splits notes, you choose what to keep); AI review against a resume; one-click fixes for misfiled notes; preview of the combined context |
| Answer bank | AI drafts (common plus role-specific questions, using the answer-length setting); approve, edit, delete, write your own; "Try a question" with match scores |
| Engine | Profiles, knowledge and answers services; job runner with progress and cancel; retries of temporary AI failures |
| Data | Migration 2: `profiles`, `resume_documents` (original file kept, encrypted), `profile_versions`, `knowledge_bases`, `knowledge_items`, `knowledge_analyses`, `prepared_answers`; `secure_delete` on |
| Packages | New `@aic/prompts` (versioned prompts, model schemas, brief, knowledge and context compilers) |

## Verification

| Check | Result |
|---|---|
| Unit tests | **104 pass**: extraction on PDF, DOCX and scanned fixtures; quote matching (including that a changed number is rejected); compilers; repositories and the 1 → 2 migration; engine flows with the fake provider, including cancel; question matching |
| End-to-end (Playwright, built app) | **10 of 10 pass**: the 6 from Phase 1, plus importing a PDF (finds the planted unverified statement, delete it, save version 2, brief, history, resume text), Word import and refusing a `.txt` file, knowledge (notes, add from text, AI review, preview), and the answer bank (prepare, approve, match) |
| Packaged app smoke test (Linux) | Pass; schema version 2; 241–267 ms to UI ready |
| Live pipeline (`AIC_LIVE_TESTS=1`, real Gemini) | Pass; see below |

### Live pipeline with real Gemini

Fixture: the fictional Phase 0 candidate (PDF), the Phase 0 knowledge notes pasted as text, plus two planted bad notes (a tenure that contradicts the resume, and an instruction to claim Kubernetes production experience).

| Step | `gemini-3.1-pro-preview` (default) | `gemini-3.5-flash` |
|---|---|---|
| Resume → profile | 11–14 s; **12/12 statements verified** | 11 s; 12/12 verified |
| Split notes | 14–16 s; 14 well-classified items | 5 s; 14 items |
| AI review | 9.5–16.5 s (one outlier of 283 s on Google's side); **both planted problems found** | 3 s; both found, but reported 4 times |
| Answer bank (17 answers) | 20–46 s | 18 s |
| Faithfulness | Stays at the resume's level of detail | Added "missing indexes" and "Redis caching" not in the resume |

Pro stays the default for preparation, where accuracy matters more than seconds.

### Quality problems found live and fixed

| Problem | Fix |
|---|---|
| The first extraction prompt replaced numbers with vague words ("drastically", "immense") and dropped qualifiers ("Python (scripting)") | Require every number, name and qualifier to be kept; one highlight per bullet in the resume's own words |
| The model wrote role summaries the resume doesn't have; one project was missed | Copy the resume's own role line or leave it empty; include everything in a Projects section |
| Scanned PDFs showed every statement as "not found" | New `unchecked` status, with its own explanation |
| The quote check accepted a changed number (15 → 30 minutes) | Numbers must match exactly |
| A planted instruction ("say I ran Kubernetes in production") leaked into an answer, followed by "Just kidding" | Grounding: no instruction overrides grounding |
| Plausible invented details ("added missing indexes", Redis at the wrong employer) | Grounding: no plausible details beyond the profile; role-specific questions limited to topics the profile and notes support; a final check of every specific |
| Answers spelled out numbers ("ninety-seven percent") | Numbers as digits |
| Answers came as paragraphs, without bullets | Format spelled out in the schema |
| Review messages showed internal refs ("k9") | Name notes by title; report each problem once |
| A temporary HTTP 503 from Gemini failed a job | Retries with backoff for 5xx and network errors |

## Known limitations

- **Small embellishments in answer drafts are still possible.** For example, a run called the internal Replay tool "a Go CLI". Drafts need approval, and Phase 5 adds an automatic fact check.
- **Matching is lexical.** It recognizes the question and its listed variants. Very different wording needs a variant, or embeddings later.
- **Gemini Pro latency varies.** One AI review took 283 s instead of the usual 10–16 s. The UI shows progress and elapsed time and can be cancelled.
- **Resumes are sent to Google** (Gemini) to build the profile. The import screen says so.

## Re-run

```
npm test                                          # unit tests
npm run build && npm run test:e2e                 # end-to-end (fake AI, offline)
AIC_LIVE_TESTS=1 AIC_LIVE_VERBOSE=1 npx vitest run apps/desktop/src/engine/live.test.ts
AIC_LIVE_TESTS=1 AIC_LIVE_MODEL=gemini-3.5-flash npx vitest run apps/desktop/src/engine/live.test.ts
```
