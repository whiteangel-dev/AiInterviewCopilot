import type { CandidateProfile, EvidenceStatus } from '@aic/ipc';
import { z } from 'zod';
import { clip } from './text';

/** Bump when the prompt or schema changes; stored with every extracted version. */
export const RESUME_PROMPT_VERSION = 'resume-extraction@2';

const quoted = z.object({
  text: z
    .string()
    .describe(
      'The statement in the resume’s own words, keeping every number, metric, name, and technology.',
    ),
  quote: z
    .string()
    .describe('Verbatim excerpt from the resume (5–40 words) that supports the statement.'),
});

const date = z
  .string()
  .nullable()
  .describe('"YYYY-MM" if the month is given, else "YYYY"; null if unknown.');

/** What the model returns. Converted to `CandidateProfile` by `toCandidateProfile`. */
export const ResumeExtractionSchema = z.object({
  name: z.string(),
  headline: z.string().describe('Current or target job title as written on the resume.'),
  location: z.string().nullable(),
  summary: z
    .string()
    .describe('2–3 plain sentences in third person, using only facts from the resume.'),
  totalYearsExperience: z
    .number()
    .nullable()
    .describe(
      'Whole years from the earliest professional role to today; null if dates are missing.',
    ),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string().nullable(),
      start: date,
      end: date.describe('null for the current role.'),
      current: z.boolean(),
      summary: z
        .string()
        .describe(
          "The resume's own description line for this role, if it has one; otherwise an empty string.",
        ),
      highlights: z.array(quoted),
      technologies: z
        .array(z.string())
        .describe("Only technologies named in this role's text or stack line."),
    }),
  ),
  projects: z.array(
    z.object({
      name: z.string(),
      context: z.string().nullable().describe('e.g. "open source", "internal, Acme", "personal".'),
      description: z.string().describe('Keep specifics such as scale, users, or star counts.'),
      highlights: z.array(quoted),
      technologies: z.array(z.string()),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string().nullable(),
      field: z.string().nullable(),
      start: date,
      end: date,
      details: z.string().nullable(),
    }),
  ),
  skills: z.array(
    z.object({
      category: z.string(),
      items: z
        .array(z.string())
        .describe('Keep qualifiers as written, e.g. "Python (scripting)", "Ruby (not recent)".'),
    }),
  ),
  certifications: z.array(
    z.object({ name: z.string(), issuer: z.string().nullable(), year: z.string().nullable() }),
  ),
  achievements: z
    .array(quoted)
    .describe('Awards, publications, patents, talks, or standout results not tied to one role.'),
  strengths: z
    .array(
      z.object({
        text: z.string().describe('A specific professional strength, under 12 words.'),
        evidence: z
          .string()
          .describe('The concrete resume facts (with their numbers) that show it.'),
      }),
    )
    .describe('3–5 strengths a recruiter would infer from the resume.'),
  languages: z.array(z.string()).describe('Spoken languages, if listed.'),
});

export type ResumeExtraction = z.infer<typeof ResumeExtractionSchema>;

export function resumeExtractionSystem(today: string): string {
  return `You extract a structured profile of a job candidate from their resume. An interview assistant will use it to help the candidate answer questions truthfully, so accuracy matters more than completeness.

RULES
- Use only what the resume says. Never add employers, titles, dates, numbers, technologies, or achievements that aren't in it.
- Specifics are the point. Keep every number, metric, scale, name, and technology from the resume. Never replace them with vague words ("significantly", "drastically", "immense", "popular", "large datasets"), and never embellish ("world-class", "spearheaded").
- One highlight per resume bullet or achievement sentence, in the resume's order. Its text is that bullet in the resume's own words; you may drop filler words only.
- Every highlight and achievement also needs a "quote": an exact excerpt from the resume, 5–40 words, that supports it. Copy it character for character, including numbers and punctuation. Don't merge text from different places into one quote.
- Keep the qualifiers the candidate wrote, such as "(not recent)", "(scripting)", "basic", or "familiar with". They matter for honest answers.
- Dates: "YYYY-MM" when the month is given, otherwise "YYYY". For the current role, end is null and current is true.
- totalYearsExperience: whole years from the earliest professional role's start to today (${today}). Don't count education.
- headline: the candidate's current or target title as written on the resume.
- summary: 2–3 plain sentences in third person, built only from resume facts.
- skills: keep the resume's grouping. If skills aren't grouped, use: Languages, Frameworks, Data, Cloud and infrastructure, Tools, Other.
- Role summary: copy the resume's description line for the role if there is one; otherwise leave it empty. Never write one yourself.
- projects: everything listed in a Projects section, plus clearly separate side, open-source, or academic work. Don't turn ordinary role highlights into projects.
- strengths: 3–5 modest, specific strengths with concrete evidence. These are interpretations; make that clear by tying each to facts.
- Leave a list empty when the resume has nothing for it. Don't output email addresses or phone numbers.

Today's date: ${today}.`;
}

export const RESUME_USER_PROMPT = 'Extract the profile from this resume.';

const LIMITS = { short: 160, line: 600, long: 1200 } as const;

/**
 * Converts model output to a stored profile. Each quote is checked with
 * `isQuoteInResume`; unfound quotes are marked `unverified` for the user to
 * review. Pass null when the resume has no text layer: quotes are `unchecked`.
 */
export function toCandidateProfile(
  x: ResumeExtraction,
  isQuoteInResume: ((quote: string) => boolean) | null,
): CandidateProfile {
  const status = (quote: string): EvidenceStatus => {
    if (!isQuoteInResume) return 'unchecked';
    return quote.trim() && isQuoteInResume(quote) ? 'verified' : 'unverified';
  };
  const points = (list: { text: string; quote: string }[]) =>
    list
      .filter((p) => p.text.trim())
      .map((p) => ({
        text: clip(p.text, LIMITS.line),
        quote: p.quote.trim() ? clip(p.quote, 800) : null,
        status: status(p.quote),
      }));
  const opt = (s: string | null, max: number = LIMITS.short) => (s?.trim() ? clip(s, max) : null);
  const list = (items: string[], max = 80) =>
    [...new Set(items.map((i) => i.trim()).filter(Boolean))].map((i) => clip(i, max));
  const years = x.totalYearsExperience;

  return {
    name: clip(x.name, 120),
    headline: clip(x.headline, 200),
    location: opt(x.location, 120),
    summary: clip(x.summary, 2000),
    totalYearsExperience: years !== null && years >= 0 && years <= 70 ? Math.round(years) : null,
    experience: x.experience.slice(0, 40).map((e) => ({
      company: clip(e.company, LIMITS.short),
      title: clip(e.title, LIMITS.short),
      location: opt(e.location, 120),
      start: opt(e.start, 20),
      end: e.current ? null : opt(e.end, 20),
      current: e.current,
      summary: clip(e.summary, LIMITS.long),
      highlights: points(e.highlights).slice(0, 30),
      technologies: list(e.technologies).slice(0, 60),
    })),
    projects: x.projects.slice(0, 40).map((p) => ({
      name: clip(p.name, LIMITS.short),
      context: opt(p.context),
      description: clip(p.description, LIMITS.long),
      highlights: points(p.highlights).slice(0, 20),
      technologies: list(p.technologies).slice(0, 60),
    })),
    education: x.education.slice(0, 15).map((e) => ({
      institution: clip(e.institution, 200),
      degree: opt(e.degree),
      field: opt(e.field),
      start: opt(e.start, 20),
      end: opt(e.end, 20),
      details: opt(e.details, LIMITS.line),
    })),
    skills: x.skills
      .slice(0, 30)
      .map((s) => ({ category: clip(s.category, 100), items: list(s.items).slice(0, 80) }))
      .filter((s) => s.items.length > 0),
    certifications: x.certifications.slice(0, 40).map((c) => ({
      name: clip(c.name, 200),
      issuer: opt(c.issuer),
      year: opt(c.year, 20),
    })),
    achievements: points(x.achievements).slice(0, 40),
    strengths: x.strengths.slice(0, 12).map((s) => ({
      text: clip(s.text, 300),
      evidence: clip(s.evidence, 800),
      status: 'inferred' as const,
    })),
    languages: list(x.languages, 60).slice(0, 15),
  };
}
