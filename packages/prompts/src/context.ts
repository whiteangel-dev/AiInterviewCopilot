import type { ContextPreview } from '@aic/ipc';
import { approxTokens } from './text';

/**
 * The per-session context block of the answer prompt, in cache-friendly order
 * (static for the whole session): session facts, then the Candidate Brief,
 * then the compiled knowledge.
 */
export function buildSessionContext(opts: {
  today: string;
  company?: string | null;
  role?: string | null;
  brief: string | null;
  knowledge: string | null;
}): ContextPreview {
  const sections: { title: string; body: string }[] = [];
  const session = [`- Today's date: ${opts.today}`];
  if (opts.company) session.push(`- Company: ${opts.company}`);
  if (opts.role) session.push(`- Role: ${opts.role}`);
  sections.push({ title: 'SESSION', body: session.join('\n') });
  sections.push({
    title: 'CANDIDATE PROFILE',
    body: opts.brief?.trim() || '(no profile selected)',
  });
  sections.push({ title: 'CANDIDATE KNOWLEDGE', body: opts.knowledge?.trim() || '(none)' });
  const text = sections.map((s) => `${s.title}\n${s.body}`).join('\n\n');
  return {
    text,
    approxTokens: approxTokens(text),
    sections: sections.map((s) => ({ title: s.title, approxTokens: approxTokens(s.body) })),
  };
}
