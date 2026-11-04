/**
 * Offline stand-ins for the live path (FakeProvider): a rule-based turn
 * analyzer and canned answers, so tests and development run without a key.
 */

const QUESTION_CUE =
  /\?|^(?:tell me|walk me|talk me|describe|explain|can you|could you|would you|why|what|how|where|when|which|who|do you|did you|have you|are you|is there)\b/i;
const TRAILING_LEAD_IN = /(?:,|\b(?:and|so|um|uh|like|but|or|because))\s*$/i;

function section(input: string, title: string): string {
  const start = input.indexOf(`${title}\n`);
  if (start < 0) return '';
  const rest = input.slice(start + title.length + 1);
  const end = rest.search(/\n\n[A-Z' ]+\n/);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

const sentences = (text: string) =>
  (text.match(/[^.?!]+[.?!]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

/** A turn-analyzer verdict (JSON) for the analyzer input built by turnAnalyzerInput. */
export function fakeTurnVerdict(input: string): string {
  const turn = section(input, 'CURRENT TURN SO FAR')
    .replace(/\n*\(The interviewer has now been silent for over a second\.\)$/, '')
    .trim();
  const longSilence = input.includes('silent for over a second');
  const asks = sentences(turn).filter((s) => QUESTION_CUE.test(s));
  const unfinished = TRAILING_LEAD_IN.test(turn) || /\b(?:a time when|about)\s*$/i.test(turn);
  const complete = !unfinished || longSilence;
  const action = !complete ? 'wait' : asks.length > 0 ? 'answer' : 'ignore';
  return JSON.stringify({
    complete,
    confidence: complete ? 0.9 : 0.8,
    action,
    type: action === 'answer' ? (/yourself/i.test(turn) ? 'background' : 'other') : 'statement',
    isFollowUp: action === 'answer' && /^(?:and|so|why not|what about)\b/i.test(asks.at(-1) ?? ''),
    standaloneQuestion: action === 'answer' ? (asks.at(-1) ?? turn) : '',
  });
}

const CANNED: [RegExp, string][] = [
  [
    /how(?:'s| is| are)? (?:your day|you doing|it going)|how are you/i,
    "It's going well, thanks. I'm glad we could make the time work.",
  ],
  [
    /yourself/i,
    "Sure. I'm a backend engineer with about six years of experience.\n- Most of my work has been on event-driven systems and APIs.\n- Lately I've led a small squad on our shipment-event pipeline.\n- I like making services faster and easier to run.",
  ],
  [
    /why .*(?:role|position|company|here|us)|interested in/i,
    "I like how much this team cares about reliability.\n- The problems you're solving line up with what I've been doing.\n- I'd get to own services end to end.",
  ],
  [
    /production issue|incident|outage/i,
    'The one I think about most was a consumer lag incident on our event pipeline.\n- Lag grew to about two hours during a traffic peak.\n- I led the response: we rolled back a deploy and scaled consumers.\n- Afterward we added lag alerts and load tests before peak season.',
  ],
  [
    /questions? (?:do you have )?for (?:us|me)/i,
    'Yes, a couple.\n- How does the team decide what to work on each quarter?\n- What does success look like in the first six months?',
  ],
];

/** A canned answer in the live format for the input built by liveAnswerInput. */
export function fakeLiveAnswer(input: string): string {
  const turn = section(input, "INTERVIEWER'S LATEST TURN");
  for (const [pattern, answer] of CANNED) if (pattern.test(turn)) return answer;
  if (!sentences(turn).some((s) => QUESTION_CUE.test(s))) return 'That makes sense, thanks.';
  return "Here's how I'd think about that.\n- I'd start by making sure I understand the goal.\n- Then I'd walk through a real example from my work.";
}

/**
 * A fact-check verdict (JSON) for the input built by factCheckInput: flags the
 * canned "small squad" line, so tests can see a highlighted issue.
 */
export function fakeFactCheck(input: string): string {
  const answer = section(input, 'ANSWER');
  const issues = /led a small squad/.test(answer)
    ? [
        {
          quote: "Lately I've led a small squad",
          problem: "Your profile doesn't say you led a squad.",
          fix: null,
        },
      ]
    : [];
  return JSON.stringify({ issues });
}

/** Splits a reply into stream pieces of a few words. */
export function streamPieces(text: string, wordsPerPiece = 4): string[] {
  const words = text.split(/(?<=\s)/);
  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerPiece) {
    pieces.push(words.slice(i, i + wordsPerPiece).join(''));
  }
  return pieces;
}
