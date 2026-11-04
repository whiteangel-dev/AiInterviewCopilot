import type { CandidateProfile } from '@aic/ipc';

/** Most terms sent to the recognizer as custom vocabulary. */
export const MAX_VOCABULARY = 100;
const MAX_TERM_LENGTH = 40;

/** Words that look like names (KestrelPay, gRPC, OAuth2, PostgreSQL) in free text. */
const NAME_LIKE = /\b[A-Za-z][A-Za-z0-9]*(?:[A-Z][a-z0-9]*|[0-9])[A-Za-z0-9]*\b/g;

/**
 * Names and technical terms the speech recognizer should expect in this
 * interview: the candidate's name, employers, projects, technologies, schools
 * and certifications from the profile, plus name-like words from the notes.
 * Most important first, deduplicated, at most 100.
 */
export function buildVocabulary(
  profile: CandidateProfile | null,
  notes: readonly { content: string; title: string }[] = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (term: string | null | undefined) => {
    const t = term?.replace(/\s+/g, ' ').trim();
    if (!t || t.length > MAX_TERM_LENGTH || out.length >= MAX_VOCABULARY) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  if (profile) {
    for (const part of profile.name.split(/\s+/)) if (part.length > 1) add(part);
    for (const e of profile.experience) add(e.company);
    for (const p of profile.projects) add(p.name);
    // Technologies, the most used first.
    const counts = new Map<string, { term: string; n: number }>();
    const techs = [
      ...profile.experience.flatMap((e) => e.technologies),
      ...profile.projects.flatMap((p) => p.technologies),
      ...profile.skills.flatMap((s) => s.items),
    ];
    for (const t of techs) {
      const key = t.trim().toLowerCase();
      if (!key) continue;
      const c = counts.get(key);
      if (c) c.n++;
      else counts.set(key, { term: t.trim(), n: 1 });
    }
    for (const { term } of [...counts.values()].sort((a, b) => b.n - a.n)) add(term);
    for (const e of profile.education) add(e.institution);
    for (const c of profile.certifications) add(c.name);
  }
  for (const note of notes) {
    for (const m of `${note.title} ${note.content}`.matchAll(NAME_LIKE)) add(m[0]);
  }
  return out;
}
