/**
 * Canned model replies for the offline FakeProvider (tests, e2e, development).
 * The resume reply matches fixtures/resume-jordan-rivera.*, with one quote that
 * is deliberately not in the resume so "unverified" paths are exercised.
 */
const resume = {
  name: 'Jordan Rivera',
  headline: 'Senior Backend Engineer',
  location: 'Austin, TX',
  summary:
    'Jordan Rivera is a senior backend engineer focused on high-throughput, event-driven systems, reliability, and developer tooling. Jordan has led squads of 4–6 engineers.',
  totalYearsExperience: 11,
  experience: [
    {
      company: 'Quayside Logistics',
      title: 'Senior Software Engineer, Platform',
      location: null,
      start: '2021-03',
      end: null,
      current: true,
      summary: '',
      highlights: [
        {
          text: 'Led the redesign of the shipment-event pipeline to Kafka streaming on AWS MSK, cutting tracking-update latency from about 15 minutes to under 5 seconds.',
          quote: 'cut tracking-update latency from about 15 minutes to under 5 seconds',
        },
        {
          text: 'Introduced idempotent consumers and a transactional outbox in PostgreSQL; duplicate customer notifications dropped by 97%.',
          quote: 'duplicate customer notifications dropped by 97%',
        },
        {
          text: 'Won the company-wide engineering excellence award in 2023.',
          quote: 'Won the company-wide engineering excellence award in 2023',
        },
      ],
      technologies: ['TypeScript', 'Go', 'Kafka', 'PostgreSQL'],
    },
    {
      company: 'Tallgrass Health',
      title: 'Software Engineer II, promoted to Senior',
      location: null,
      start: '2017-06',
      end: '2021-02',
      current: false,
      summary: '',
      highlights: [
        {
          text: 'Built the appointment-scheduling API used by 120 clinics; brought p95 latency from 900 ms to 180 ms.',
          quote: 'brought p95 latency from 900 ms to 180 ms through query tuning and caching',
        },
      ],
      technologies: ['Node.js', 'Express', 'PostgreSQL'],
    },
  ],
  projects: [
    {
      name: 'openslo-lint',
      context: 'open source',
      description: 'A CLI that validates SLO definition files; about 600 GitHub stars.',
      highlights: [],
      technologies: ['Go'],
    },
  ],
  education: [
    {
      institution: 'University of Texas at Austin',
      degree: 'B.S.',
      field: 'Computer Science',
      start: null,
      end: '2015',
      details: null,
    },
  ],
  skills: [
    { category: 'Languages', items: ['TypeScript', 'Go', 'SQL', 'Python (scripting)'] },
    { category: 'Data and streaming', items: ['Kafka', 'PostgreSQL', 'Redis'] },
  ],
  certifications: [
    { name: 'AWS Certified Solutions Architect – Associate', issuer: null, year: '2022' },
  ],
  achievements: [],
  strengths: [
    {
      text: 'Latency and reliability work at scale',
      evidence:
        'Cut tracking latency from 15 minutes to under 5 seconds; p95 from 900 ms to 180 ms.',
    },
  ],
  languages: [],
};

const answers = {
  answers: [
    {
      question: 'Tell me about yourself.',
      variants: ['Walk me through your background.', 'Can you introduce yourself?'],
      category: 'intro',
      answer:
        "I'm a backend engineer with about eleven years in event-driven systems.\n- Most recently I led Quayside's move to Kafka streaming.\n- Before that I built Tallgrass Health's scheduling API.",
    },
    {
      question: 'What are your salary expectations?',
      variants: ["What's your expected compensation?", 'What salary are you looking for?'],
      category: 'logistics',
      answer:
        "I'd love to hear the range you have in mind first.\n- I'm flexible depending on the overall package.",
    },
    {
      question: 'How did you cut tracking-update latency at Quayside?',
      variants: ['Tell me about the Kafka migration.'],
      category: 'technical',
      answer:
        'We replaced a cron-based batch job with Kafka streaming on MSK.\n- Latency went from about 15 minutes to under 5 seconds.\n- Idempotent consumers kept duplicates down.',
    },
  ],
};

interface ParsedItem {
  ref: string;
  content: string;
}

function parseNotes(text: string): ParsedItem[] {
  return [...text.matchAll(/^\[(k\d+)\] \([^)]*\) (.*)$/gm)].map((m) => ({
    ref: m[1]!,
    content: m[2]!.replace(/^[^:]{1,60}: /, ''),
  }));
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function analyze(text: string) {
  const items = parseNotes(text);
  const seen = new Map<string, string>();
  const issues = [];
  for (const item of items) {
    const key = norm(item.content);
    const first = seen.get(key);
    if (first) {
      issues.push({
        type: 'duplicate',
        refs: [first, item.ref],
        involvesResume: false,
        message: 'These two notes say the same thing.',
        suggestion: 'Delete one of them.',
      });
    } else seen.set(key, item.ref);
  }
  return {
    summary: issues.length ? 'Mostly ready; fix the duplicates.' : 'These notes look ready to use.',
    issues,
    reclassify: [],
  };
}

const INSTRUCTION = /^(always|never|don't|do not|avoid|keep|sound|try|please|mention|say)\b/i;

function split(text: string) {
  const chunks = text
    .split(/\n\s*\n|\n(?=\s*[-•*]\s)/)
    .map((c) => c.replace(/^\s*[-•*]\s*/, '').trim())
    .filter((c) => c && !/^#+\s/.test(c));
  return {
    items: chunks.map((content) => ({
      kind: INSTRUCTION.test(content) ? 'instruction' : 'fact',
      category: /salary|\$|compensation|base pay/i.test(content) ? 'compensation' : 'other',
      title: content.split(/\s+/).slice(0, 4).join(' '),
      content,
    })),
  };
}

export function fakeStructuredReply(task: string, inputText: string): unknown {
  switch (task) {
    case 'resume_extraction':
      return resume;
    case 'knowledge_analysis':
      return analyze(inputText);
    case 'knowledge_split':
      return split(inputText.replace(/^NOTES\n/, ''));
    case 'answer_bank':
      return answers;
    default:
      throw new Error(`FakeProvider has no reply for task "${task}"`);
  }
}
