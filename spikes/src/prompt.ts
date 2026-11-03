import { readFileSync } from 'node:fs';
import type { Content } from '@google/genai';

export interface Question {
  id: string;
  kind: 'answer' | 'skip';
  type: string;
  text: string;
  parent?: string;
  candidateSaid?: string;
}

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

export const loadQuestions = (): Question[] => JSON.parse(readFileSync(fixture('questions.json'), 'utf8')) as Question[];
export const loadProfile = () => readFileSync(fixture('profile.md'), 'utf8');
export const loadKnowledge = () => readFileSync(fixture('knowledge.md'), 'utf8');

const RULES = `You are an interview copilot. The user is a job candidate in a live job interview.
For the interviewer's latest turn, write what the candidate could say next — in first person, as the candidate.

GROUNDING
- Every claim about the candidate must come from CANDIDATE PROFILE or CANDIDATE KNOWLEDGE.
- Never invent employers, projects, technologies, numbers, dates, or results.
- If the candidate has no relevant experience, say so honestly in one short clause, then bridge to the closest real experience.
- Don't invent personal details either (how the day went, hobbies, opinions not in the knowledge). Keep small talk generic.
- Compute durations from the dates in the profile and today's date in SESSION.
- Follow the candidate's "Answer instructions" in CANDIDATE KNOWLEDGE.
- For follow-up questions, stay consistent with what the candidate already said (lines starting "Candidate:" in INTERVIEW SO FAR).

VOICE
- Natural spoken American English: always use contractions (I'm, I've, it's, didn't), plain words, short sentences.
- No clichés or filler such as "passionate", "leverage", "synergy", "fast-paced environment", "team player", "great question".
- No headings, no labels like "Situation:", no meta-commentary, no quotation marks around the answer.

FORMAT
- Line 1: one sentence the candidate can start saying immediately. No bullet.
- Then 2 to 4 bullets ("- "), each under 18 words, in the order the candidate should say them.
- Behavioral questions: fold the story into the bullets (context, what I did, result, what I learned).
- Technical questions: direct answer first, then a concrete example from the profile, then a trade-off.
- Total length: about 45 seconds when spoken.
- Small talk: one or two friendly sentences, no bullets.

SKIP
- If the interviewer's turn does not ask the candidate anything, output exactly: [SKIP]
- This includes statements that only give context (team size, tech stack, schedule, company facts), filler, and thinking aloud.`;

/**
 * Static, per-session system instruction (rules + profile + knowledge + session).
 * Kept byte-identical across requests so provider-side prefix caching can hit.
 */
export function buildSystemInstruction(
  session = { company: 'Kestrel Pay', role: 'Senior Backend Engineer, Ledger team', date: new Date().toISOString().slice(0, 10) },
): string {
  return [
    RULES,
    `SESSION\n- Today's date: ${session.date}\n- Company: ${session.company}\n- Role: ${session.role}\n- Interview type: mixed behavioral and technical`,
    `CANDIDATE PROFILE\n${loadProfile().trim()}`,
    `CANDIDATE KNOWLEDGE\n${loadKnowledge().trim()}`,
  ].join('\n\n');
}

/**
 * Per-request contents: append-only interview history, then the current turn.
 * For the benchmark, history is the parent question (and what the candidate said)
 * for follow-ups; the real app appends the whole session.
 */
export function buildContents(q: Question, all: Question[]): Content[] {
  const history: string[] = [];
  const parent = q.parent ? all.find((x) => x.id === q.parent) : undefined;
  if (parent) {
    history.push(`Interviewer: ${parent.text}`);
    if (parent.candidateSaid) history.push(`Candidate: ${parent.candidateSaid}`);
  }
  const text = [
    `INTERVIEW SO FAR\n${history.length ? history.join('\n') : '(start of interview)'}`,
    `INTERVIEWER'S LATEST TURN\n${q.text}`,
  ].join('\n\n');
  return [{ role: 'user', parts: [{ text }] }];
}

/** Key terms from the profile, used to bias speech recognition. */
export const KEY_TERMS = [
  'Kafka', 'RabbitMQ', 'MSK', 'PostgreSQL', 'Redis', 'Kubernetes', 'ECS', 'Fargate', 'Terraform', 'Datadog',
  'OpenTelemetry', 'Node.js', 'TypeScript', 'Go', 'SQS', 'Lambda', 'Quayside', 'Tallgrass', 'Pinecrest', 'Kestrel Pay',
];
