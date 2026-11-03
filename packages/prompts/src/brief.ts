import type { CandidateProfile, ProfilePoint } from '@aic/ipc';
import { dateRange } from './text';

const join = (items: readonly string[]) => items.filter(Boolean).join(', ');
const point = (p: ProfilePoint) => p.text.trim();

/**
 * Compiles a profile into the Candidate Brief: compact, deterministic text that
 * answer prompts include verbatim. No model is involved, so nothing can be
 * invented here and the same profile always gives the same brief (good for
 * prompt caching).
 */
export function compileBrief(p: CandidateProfile): string {
  const lines: string[] = [];
  const who = [p.name || 'The candidate', p.headline].filter(Boolean).join(' — ');
  const where = p.location ? ` (${p.location})` : '';
  lines.push(`${who}${where}`);
  if (p.totalYearsExperience !== null) {
    lines.push(`Professional experience: about ${p.totalYearsExperience} years.`);
  }
  if (p.summary) lines.push(`Summary: ${p.summary.trim()}`);

  if (p.experience.length) {
    lines.push('', 'EXPERIENCE');
    for (const e of p.experience) {
      const dates = dateRange(e.start, e.end, e.current);
      const place = e.location ? `, ${e.location}` : '';
      lines.push(`- ${e.title} — ${e.company}${place}${dates ? ` (${dates})` : ''}`);
      if (e.summary) lines.push(`  ${e.summary.trim()}`);
      for (const h of e.highlights) if (h.text.trim()) lines.push(`  • ${point(h)}`);
      if (e.technologies.length) lines.push(`  Tech: ${join(e.technologies)}`);
    }
  }

  if (p.projects.length) {
    lines.push('', 'PROJECTS');
    for (const pr of p.projects) {
      const ctx = pr.context ? ` (${pr.context})` : '';
      lines.push(`- ${pr.name}${ctx}: ${pr.description.trim()}`);
      for (const h of pr.highlights) if (h.text.trim()) lines.push(`  • ${point(h)}`);
      if (pr.technologies.length) lines.push(`  Tech: ${join(pr.technologies)}`);
    }
  }

  if (p.skills.length) {
    lines.push('', 'SKILLS');
    for (const s of p.skills) if (s.items.length) lines.push(`- ${s.category}: ${join(s.items)}`);
  }

  if (p.education.length) {
    lines.push('', 'EDUCATION');
    for (const ed of p.education) {
      const degree = join([ed.degree ?? '', ed.field ?? '']);
      const dates = dateRange(ed.start, ed.end, false);
      lines.push(
        `- ${[degree, ed.institution].filter(Boolean).join(', ')}${dates ? ` (${dates})` : ''}${ed.details ? `. ${ed.details}` : ''}`,
      );
    }
  }

  if (p.certifications.length) {
    lines.push('', 'CERTIFICATIONS');
    for (const c of p.certifications) {
      lines.push(`- ${c.name}${c.issuer ? `, ${c.issuer}` : ''}${c.year ? ` (${c.year})` : ''}`);
    }
  }

  const achievements = p.achievements.filter((a) => a.text.trim());
  if (achievements.length) {
    lines.push('', 'ACHIEVEMENTS');
    for (const a of achievements) lines.push(`- ${point(a)}`);
  }

  if (p.strengths.length) {
    lines.push('', 'STRENGTHS (interpretation of the resume, not claims to repeat verbatim)');
    for (const s of p.strengths)
      lines.push(`- ${s.text.trim()}${s.evidence ? ` — ${s.evidence.trim()}` : ''}`);
  }

  if (p.languages.length) lines.push('', `Spoken languages: ${join(p.languages)}`);
  return lines.join('\n').trim();
}
