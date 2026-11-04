import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  addKey,
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
    [2500, 1500],
    [3000, 1800],
  ]);
  writeSpeechWav(candidate, [[4400, 1400]]);
  return {
    AIC_AUDIO_REPLAY_INTERVIEWER: interviewer,
    AIC_AUDIO_REPLAY_CANDIDATE: candidate,
    AIC_NATIVE_AUDIO: '0',
    AIC_PHONE_HOST: '127.0.0.1',
  };
}

test('phone screen: a phone scans the code and follows the interview', async () => {
  const { app, page } = await launch(userData, replayEnv(userData));
  try {
    await addKey(page);
    const phoneCard = page.locator('#phone');
    await phoneCard.getByRole('radio', { name: 'On' }).click();
    await expect(phoneCard.getByTestId('phone-qr')).toBeVisible();
    await expect(phoneCard.getByTestId('phone-clients')).toHaveText('No phone connected yet');
    const url = (await phoneCard.getByTestId('phone-url').textContent())!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?k=[\w-]{20,}$/);
    await screenshot(page, 'settings-phone');

    // A phone opens the link (a phone-sized browser window).
    const opened = app.waitForEvent('window', { predicate: (w) => w.url().startsWith('http://') });
    await app.evaluate(({ BrowserWindow }, link) => {
      const w = new BrowserWindow({ width: 390, height: 844, show: false });
      void w.loadURL(link);
    }, url);
    const phone: Page = await opened;
    await expect(phone.getByTestId('phone-status')).toHaveText(
      'Connected · waiting for an interview',
    );
    // The token left the address bar (it's a cookie now).
    expect(phone.url()).not.toContain('k=');
    await expect(phoneCard.getByTestId('phone-clients')).toHaveText('1 phone connected');

    // The interview starts on the computer; the phone shows the answers.
    await nav(page, 'Interview');
    await page.getByTestId('start-interview').click();
    await expect(phone.getByTestId('phone-status')).toHaveText('Listening', { timeout: 15_000 });
    const card = phone.getByTestId('answer-card');
    await expect(card.getByTestId('answer')).toContainText("I'm a backend engineer", {
      timeout: 20_000,
    });
    await expect(phone.getByTestId('transcript')).toContainText(
      'tell me a little bit about yourself',
    );
    await screenshot(phone, 'phone-answer');

    // Buttons on the phone act on the computer.
    await card.getByRole('button', { name: 'Shorter' }).click();
    await expect(card.getByTestId('answer-position')).toHaveText('3/3', { timeout: 10_000 });
    await expect(page.getByTestId('answer-card').getByTestId('answer-position')).toHaveText('3/3');

    // Unpairing disconnects it.
    await nav(page, 'Settings');
    await phoneCard.getByRole('button', { name: 'Unpair all phones' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Unpair' }).click();
    await expect(phoneCard.getByTestId('phone-clients')).toHaveText('No phone connected yet');
    await phone.reload();
    await expect(phone.locator('body')).toContainText('Scan the QR code');
  } finally {
    await app.close();
  }
});
