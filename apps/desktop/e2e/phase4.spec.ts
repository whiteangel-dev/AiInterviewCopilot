import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  addKey,
  copilotWindow,
  launch,
  nav,
  removeDir,
  screenshot,
  tempUserData,
  writeSpeechWav,
} from './fixtures';

let userData: string;
test.beforeEach(() => {
  userData = tempUserData();
});
test.afterEach(() => removeDir(userData));

/** Two interviewer questions with a reply from the candidate in between. */
function replayEnv(dir: string): Record<string, string> {
  const interviewer = join(dir, 'interviewer.wav');
  const candidate = join(dir, 'candidate.wav');
  writeSpeechWav(interviewer, [
    [1500, 1500],
    [3000, 1800],
  ]);
  writeSpeechWav(candidate, [[3400, 1400]]);
  return {
    AIC_AUDIO_REPLAY_INTERVIEWER: interviewer,
    AIC_AUDIO_REPLAY_CANDIDATE: candidate,
    AIC_NATIVE_AUDIO: '0',
  };
}

test('live answers: the copilot answers each question, and the answers are saved', async () => {
  const { app, page } = await launch(userData, replayEnv(userData));
  try {
    await addKey(page);
    await nav(page, 'Interview');
    await page.getByLabel('Company').fill('Kestrel Pay');
    await page.getByLabel('Role').fill('Senior Backend Engineer');
    await page.getByTestId('start-interview').click();
    await expect(page.getByTestId('interview-live')).toHaveAttribute('data-status', 'live');

    const copilot = await copilotWindow(app);
    const card = copilot.getByTestId('answer-card');
    // First question: small talk.
    await expect(card.getByTestId('answer')).toContainText("It's going well, thanks.", {
      timeout: 15_000,
    });
    // Second question, after the candidate replied: the card follows the newest answer.
    await expect(card.getByTestId('answer')).toContainText("I'm a backend engineer", {
      timeout: 15_000,
    });
    await expect(card.getByTestId('answer')).toHaveAttribute('data-status', 'done');
    await expect(card.getByTestId('answer')).toContainText(
      'To get started, can you tell me a little bit about yourself?',
    );
    await expect(card.getByTestId('answer-position')).toHaveText('2/2');
    await screenshot(copilot, 'copilot-answer');

    // Earlier answers are a click away.
    await card.getByRole('button', { name: 'Previous answer' }).click();
    await expect(card.getByTestId('answer')).toContainText("It's going well");
    await card.getByRole('button', { name: 'Latest answer ›' }).click();
    await expect(card.getByTestId('answer-position')).toHaveText('2/2');

    // "Shorter" writes a new answer to the same question.
    await card.getByRole('button', { name: 'Shorter' }).click();
    await expect(card.getByTestId('answer-position')).toHaveText('3/3');
    await expect(card).toContainText('Rewritten');
    await expect(card.getByTestId('answer')).toHaveAttribute('data-status', 'done');

    // The main window shows the same answers.
    await expect(page.getByTestId('answer-card').getByTestId('answer-position')).toHaveText('3/3');
    await screenshot(page, 'interview-answer');

    await page.getByTestId('end-interview').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'End interview' }).click();
    await page.getByRole('button', { name: 'Open transcript' }).click();
    const detail = page.getByTestId('session-detail');
    await expect(detail).toContainText('Kestrel Pay · Senior Backend Engineer');
    await expect(detail.getByTestId('transcript-answer')).toHaveCount(3);
    await screenshot(page, 'session-answers');
    await detail.getByRole('button', { name: 'Hide answers' }).click();
    await expect(detail.getByTestId('transcript-answer')).toHaveCount(0);

    await nav(page, 'Sessions');
    await expect(page.getByTestId('session-list')).toContainText('3 answers');
  } finally {
    await app.close();
  }
});

test('live answers: with automatic answers off, "Answer now" answers on request', async () => {
  const { app, page } = await launch(userData, replayEnv(userData));
  try {
    await addKey(page);
    await nav(page, 'Settings');
    const answers = page.locator('#answers');
    await answers
      .locator('[aria-label="Answer automatically"]')
      .getByRole('radio', { name: 'Off' })
      .click();
    await expect(answers).toContainText('Answers appear only when you press Answer now');
    await expect(page.locator('#hotkeys')).toContainText('Ctrl + Alt + Enter');

    await nav(page, 'Interview');
    await page.getByTestId('start-interview').click();
    const copilot = await copilotWindow(app);
    await expect(copilot.getByTestId('transcript')).toContainText("How's your day going so far?", {
      timeout: 15_000,
    });
    await copilot.waitForTimeout(800);
    await expect(copilot.getByTestId('answer')).toHaveCount(0);

    await copilot.getByTestId('answer-now').click();
    await expect(copilot.getByTestId('answer')).toContainText("It's going well", {
      timeout: 10_000,
    });
    await expect(copilot.getByTestId('answer-card')).toContainText('On request');
    await page.getByTestId('end-interview').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'End interview' }).click();
  } finally {
    await app.close();
  }
});
