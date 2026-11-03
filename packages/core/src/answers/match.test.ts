import { describe, expect, it } from 'vitest';
import { CONFIDENT_MATCH, matchQuestion, questionTokens } from './match';

const bank = [
  {
    question: 'Tell me about yourself.',
    variants: ['Walk me through your background.', 'Can you introduce yourself?'],
  },
  {
    question: 'What are your salary expectations?',
    variants: ["What's your expected compensation?", 'What salary are you looking for?'],
  },
  {
    question: 'Tell me about a time you disagreed with a teammate.',
    variants: ['Describe a conflict with a coworker and how you resolved it.'],
  },
  { question: 'Why did you choose Kafka over RabbitMQ?', variants: [] },
];

describe('matchQuestion', () => {
  it('drops filler and stems lightly', () => {
    expect([
      ...questionTokens("So, tell me a little bit about yourself, if you don't mind."),
    ]).toEqual(['yourself', 'dont', 'mind']);
    expect(questionTokens('expectations')).toEqual(new Set(['expectation']));
  });

  it.each([
    ['So tell me a little bit about yourself.', 0],
    ['Could you walk me through your background?', 0],
    ['What salary are you looking for in this role?', 1],
    ['Can you describe a conflict you had with a coworker?', 2],
    ['Why Kafka and not RabbitMQ?', 3],
  ])('"%s" matches confidently', (question, index) => {
    const [best] = matchQuestion(question, bank);
    expect(best?.item).toBe(bank[index]);
    expect(best!.score).toBeGreaterThanOrEqual(CONFIDENT_MATCH);
  });

  it('does not match unrelated questions', () => {
    expect(matchQuestion('How do you design a rate limiter?', bank)).toEqual([]);
    expect(matchQuestion('', bank)).toEqual([]);
  });
});
