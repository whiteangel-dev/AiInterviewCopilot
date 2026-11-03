import { EMPTY_PROFILE } from '@aic/ipc';
import { describe, expect, it } from 'vitest';
import { answerBankSystem } from './answers';
import { compileBrief } from './brief';
import { buildSessionContext } from './context';
import { compileKnowledge } from './knowledge';
import { toCandidateProfile, type ResumeExtraction } from './resume';
import { dateRange, formatMonth } from './text';

const extraction: ResumeExtraction = {
  name: 'Sam Lee',
  headline: 'Data Engineer',
  location: 'Denver, CO',
  summary: 'Data engineer.',
  totalYearsExperience: 6.4,
  experience: [
    {
      company: 'Acme',
      title: 'Data Engineer',
      location: null,
      start: '2020-01',
      end: '2024-05',
      current: true,
      summary: '',
      highlights: [
        {
          text: 'Built the Spark pipeline for 2 TB/day.',
          quote: 'Built the Spark pipeline for 2 TB/day',
        },
        { text: 'Won an award.', quote: 'Won the award for best team' },
        { text: '  ', quote: '' },
      ],
      technologies: ['Spark', 'Spark', ' Airflow '],
    },
  ],
  projects: [],
  education: [],
  skills: [
    { category: 'Languages', items: ['Python (scripting)'] },
    { category: 'Empty', items: [] },
  ],
  certifications: [],
  achievements: [],
  strengths: [{ text: 'Scale', evidence: '2 TB/day pipeline' }],
  languages: [],
};

describe('toCandidateProfile', () => {
  it('checks quotes and cleans the output', () => {
    const p = toCandidateProfile(extraction, (q) => q.includes('Spark'));
    const [role] = p.experience;
    expect(role!.end).toBeNull(); // current role
    expect(role!.highlights.map((h) => h.status)).toEqual(['verified', 'unverified']);
    expect(role!.technologies).toEqual(['Spark', 'Airflow']);
    expect(p.totalYearsExperience).toBe(6);
    expect(p.skills).toEqual([{ category: 'Languages', items: ['Python (scripting)'] }]);
    expect(p.strengths[0]!.status).toBe('inferred');
  });

  it('marks quotes unchecked when the resume has no text layer', () => {
    const p = toCandidateProfile(extraction, null);
    expect(p.experience[0]!.highlights.map((h) => h.status)).toEqual(['unchecked', 'unchecked']);
  });
});

describe('compileBrief', () => {
  it('is compact, ordered, and keeps specifics', () => {
    const p = toCandidateProfile(extraction, () => true);
    const brief = compileBrief(p);
    expect(brief).toContain('Sam Lee — Data Engineer (Denver, CO)');
    expect(brief).toContain('- Data Engineer — Acme (Jan 2020 – present)');
    expect(brief).toContain('• Built the Spark pipeline for 2 TB/day.');
    expect(brief).toContain('- Languages: Python (scripting)');
    expect(brief.indexOf('EXPERIENCE')).toBeLessThan(brief.indexOf('SKILLS'));
    expect(compileBrief(p)).toBe(brief); // deterministic
  });

  it('handles an empty profile', () => {
    expect(compileBrief(EMPTY_PROFILE)).toBe('The candidate');
  });
});

describe('compileKnowledge', () => {
  it('puts instructions first and groups facts by category', () => {
    const text = compileKnowledge([
      { kind: 'fact', category: 'compensation', title: 'Target', content: '$190k base' },
      { kind: 'instruction', category: 'style', title: '', content: 'Keep it calm.\nNo hype.' },
      { kind: 'fact', category: 'experience', title: '', content: 'Led the 2022 incident.' },
    ]);
    expect(text.split('\n')).toEqual([
      'Answer instructions (follow these)',
      '- Keep it calm. No hype.',
      '',
      'Experience details (facts)',
      '- Led the 2022 incident.',
      '',
      'Salary and logistics (facts)',
      '- Target: $190k base',
    ]);
    expect(compileKnowledge([])).toBe('');
  });
});

describe('context and prompts', () => {
  it('builds the session context in cache-friendly order', () => {
    const c = buildSessionContext({ today: '2026-11-03', brief: 'BRIEF', knowledge: 'NOTES' });
    expect(c.text).toBe(
      "SESSION\n- Today's date: 2026-11-03\n\nCANDIDATE PROFILE\nBRIEF\n\nCANDIDATE KNOWLEDGE\nNOTES",
    );
    expect(c.sections.map((s) => s.title)).toEqual([
      'SESSION',
      'CANDIDATE PROFILE',
      'CANDIDATE KNOWLEDGE',
    ]);
    expect(c.approxTokens).toBeGreaterThan(0);
  });

  it('answer length changes the format rules', () => {
    expect(answerBankSystem('short')).toContain('Then 2 bullets');
    expect(answerBankSystem('detailed')).toContain('3 to 5 bullets');
  });

  it('formats dates', () => {
    expect(formatMonth('2021-03')).toBe('Mar 2021');
    expect(formatMonth('2015')).toBe('2015');
    expect(dateRange('2021-03', null, true)).toBe('Mar 2021 – present');
    expect(dateRange(null, null, false)).toBe('');
  });
});
