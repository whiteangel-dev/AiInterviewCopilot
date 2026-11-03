/** Shared turn/question analyzer prompt and output schema. */

export interface Verdict {
  complete: boolean;
  confidence: number;
  action: 'answer' | 'ignore' | 'wait';
  type: string;
  isFollowUp: boolean;
  standaloneQuestion: string;
}

export const ANALYZER_SYSTEM = `You analyze an interviewer's speech in a live job interview, in real time.
The interviewer has just paused. You get the recent conversation and the interviewer's CURRENT TURN transcript so far.

Decide:
- complete: has the interviewer finished their turn and now expects the candidate to respond?
  Not complete if the transcript ends mid-phrase, with a trailing "and", "so", "um", "like", or a comma,
  or if it is only a lead-in ("Okay, so,", "Last question from me.", "So we use Go here.", "Interesting.") that usually precedes a question.
- confidence: 0 to 1, your confidence in "complete".
- action: "answer" if the turn asks the candidate something (a question, or a request like "tell me about…", "walk me through…");
  "ignore" if the finished turn needs no answer (thanks, a statement, filler); "wait" if not complete.
- type: small_talk, background, motivation, behavioral, technical, system_design, salary, career, closing, statement, filler, or other.
- isFollowUp: true if it builds on the previous question or the candidate's last answer.
- standaloneQuestion: the question rewritten to make sense without context (resolve "that", "it", "the incident"); empty unless action is "answer".`;

/** `complete` comes first so the decision can be read from the stream early. */
export const ANALYZER_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    confidence: { type: 'number' },
    action: { type: 'string', enum: ['answer', 'ignore', 'wait'] },
    type: { type: 'string' },
    isFollowUp: { type: 'boolean' },
    standaloneQuestion: { type: 'string' },
  },
  required: ['complete', 'confidence', 'action', 'type', 'isFollowUp', 'standaloneQuestion'],
  additionalProperties: false,
};

export function analyzerUserText(transcript: string, context?: { question: string; candidateSaid?: string }): string {
  const ctx = context ? `Interviewer: ${context.question}\n${context.candidateSaid ? `Candidate: ${context.candidateSaid}` : ''}` : '(start of interview)';
  return `RECENT CONVERSATION\n${ctx}\n\nCURRENT TURN SO FAR\n${transcript}`;
}
