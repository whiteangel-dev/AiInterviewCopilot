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

test('fact check: unsupported words are marked; the session shows its cost', async () => {
  const { app, page } = await launch(userData, replayEnv(userData));
  try {
    await addKey(page);
    await nav(page, 'Interview');
    await page.getByTestId('start-interview').click();
    const copilot = await copilotWindow(app);
    const card = copilot.getByTestId('answer-card');

    // The second answer has a line the (fake) checker flags.
    await expect(card.getByTestId('answer-position')).toHaveText('2/2', { timeout: 20_000 });
    await expect(card.getByTestId('answer-check')).toHaveAttribute('data-check', 'issues', {
      timeout: 10_000,
    });
    await expect(card.getByTestId('answer-check')).toHaveText('1 to check');
    await expect(card.getByTestId('answer-issues')).toContainText(
      "Your profile doesn't say you led a squad.",
    );
    await expect(card.locator('mark')).toHaveText("Lately I've led a small squad");
    await screenshot(copilot, 'copilot-fact-check');

    // The first answer passed.
    await card.getByRole('button', { name: 'Previous answer' }).click();
    await expect(card.getByTestId('answer-check')).toHaveAttribute('data-check', 'ok');
    await expect(card.getByTestId('answer-check')).toHaveText('Checked');

    await page.getByTestId('end-interview').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'End interview' }).click();
    await page.getByRole('button', { name: 'Open transcript' }).click();
    const detail = page.getByTestId('session-detail');
    await expect(detail.getByTestId('answer-issues')).toHaveCount(1);
    await expect(detail.getByTestId('session-cost')).toContainText(
      'Estimated cost on your Gemini key',
    );
    await screenshot(page, 'session-cost');
  } finally {
    await app.close();
  }
});

test('settings: fact check and echo cancellation can be turned off', async () => {
  const { app, page } = await launch(userData, { AIC_NATIVE_AUDIO: '0' });
  try {
    await nav(page, 'Settings');
    const answers = page.locator('#answers');
    await answers.locator('[aria-label="Fact check"]').getByRole('radio', { name: 'Off' }).click();
    await expect(
      answers.locator('[aria-label="Fact check"]').getByRole('radio', { name: 'Off' }),
    ).toHaveAttribute('data-state', 'on');
    await expect(page.locator('#models')).toContainText('Backup for live answers');
    await expect(page.locator('#models')).toContainText('Fact check');

    await nav(page, 'Audio');
    const echo = page.locator('[aria-label="Echo cancellation"]');
    await expect(echo.getByRole('radio', { name: 'On' })).toHaveAttribute('data-state', 'on');
    await echo.getByRole('radio', { name: 'Off' }).click();
    await expect(echo.getByRole('radio', { name: 'Off' })).toHaveAttribute('data-state', 'on');
  } finally {
    await app.close();
  }
});
