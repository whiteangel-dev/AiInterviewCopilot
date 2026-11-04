import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { VALID_KEY, launch, removeDir, tempUserData } from './fixtures';

const SCREENS = join(__dirname, '..', 'test-results', 'screens');

async function screenshot(page: Page, name: string) {
  mkdirSync(SCREENS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SCREENS, `${name}.png`) });
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();

async function addKey(page: Page) {
  await nav(page, 'Settings');
  const card = page.getByTestId('api-key-card');
  await card.getByLabel('API key').fill(VALID_KEY);
  await card.getByRole('button', { name: 'Save key' }).click();
  await expect(card.getByText('Verified')).toBeVisible();
}

/** A 16 kHz mono WAV of silence and tone bursts (stand-ins for speech). */
function writeSpeechWav(file: string, pattern: [silenceMs: number, speechMs: number][]) {
  const samples: number[] = [];
  for (const [silence, speech] of pattern) {
    for (let i = 0; i < silence * 16; i++) samples.push(0);
    for (let i = 0; i < speech * 16; i++) {
      samples.push(Math.round(3200 * Math.sin((2 * Math.PI * 300 * i) / 16_000)));
    }
  }
  for (let i = 0; i < 30_000 * 16; i++) samples.push(0);
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16_000, 24);
  h.writeUInt32LE(32_000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
}

async function copilotWindow(app: ElectronApplication): Promise<Page> {
  const existing = app.windows().find((w) => w.url().includes('copilot.html'));
  if (existing) return existing;
  return app.waitForEvent('window', { predicate: (w) => w.url().includes('copilot.html') });
}

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
    [1000, 1800],
  ]);
  writeSpeechWav(candidate, [[3200, 700]]);
  return {
    AIC_AUDIO_REPLAY_INTERVIEWER: interviewer,
    AIC_AUDIO_REPLAY_CANDIDATE: candidate,
    AIC_NATIVE_AUDIO: '0',
  };
}

test('audio test: levels and transcription from recorded audio', async () => {
  const { app, page } = await launch(userData, replayEnv(userData));
  try {
    await addKey(page);
    await nav(page, 'Audio');
    await expect(page.getByText('In use: Test recordings.')).toBeVisible();
    await page.getByTestId('start-audio-test').click();
    const test = page.getByTestId('audio-test');
    await expect(test).toHaveAttribute('data-status', 'live');
    // The interviewer meter moves while the recording "talks".
    await expect
      .poll(
        async () => Number(await page.getByTestId('meter-interviewer').getAttribute('data-db')),
        {
          timeout: 15_000,
        },
      )
      .toBeGreaterThan(-40);
    await expect(test.getByTestId('transcript')).toContainText('Hi, thanks for joining us today', {
      timeout: 15_000,
    });
    await screenshot(page, 'audio-test');
    await page.getByRole('button', { name: 'Stop test' }).click();
    await expect(test).toHaveAttribute('data-status', 'ended');
  } finally {
    await app.close();
  }
});

test('interview: copilot window shows the live transcript; the session is saved', async () => {
  const { app, page } = await launch(userData, replayEnv(userData));
  try {
    await addKey(page);
    await nav(page, 'Interview');
    await page.getByLabel('Interview title').fill('Acme, round 1');
    await page.getByTestId('start-interview').click();
    await expect(page.getByTestId('interview-live')).toHaveAttribute('data-status', 'live');
    await expect(page.getByTestId('nav-live')).toBeVisible();

    // The copilot window opens by itself and follows the conversation.
    const copilot = await copilotWindow(app);
    await expect(copilot.getByTestId('copilot-status')).toHaveText('Listening');
    await expect(copilot.getByTestId('transcript')).toContainText(
      "Hi, thanks for joining us today. How's your day going so far?",
      { timeout: 15_000 },
    );
    await expect(copilot.getByTestId('transcript')).toContainText(
      'tell me a little bit about yourself',
      {
        timeout: 15_000,
      },
    );
    await expect(copilot.locator('[data-channel="candidate"]').first()).toBeVisible();
    await screenshot(copilot, 'copilot-window');
    await expect(page.getByTestId('transcript')).toContainText('Hi, thanks for joining us today');
    await screenshot(page, 'interview-live');

    // Pause and resume from the copilot window.
    await copilot.getByRole('button', { name: 'Pause listening' }).click();
    await expect(page.getByTestId('interview-live')).toHaveAttribute('data-status', 'paused');
    await copilot.getByRole('button', { name: 'Resume listening' }).click();
    await expect(page.getByTestId('interview-live')).toHaveAttribute('data-status', 'live');

    // End from the main window.
    await page.getByTestId('end-interview').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'End interview' }).click();
    await expect(page.getByTestId('interview-ended')).toBeVisible();
    await expect(copilot.getByTestId('copilot-status')).toHaveText('Interview ended');

    await page.getByRole('button', { name: 'Open transcript' }).click();
    const detail = page.getByTestId('session-detail');
    await expect(detail).toContainText('Acme, round 1');
    await expect(detail.locator('[data-channel="interviewer"]')).toHaveCount(2);
    await screenshot(page, 'session-detail');

    await nav(page, 'Sessions');
    await expect(page.getByTestId('session-list')).toContainText('Acme, round 1');
  } finally {
    await app.close();
  }
});

test('settings: copilot window and shortcuts', async () => {
  const { app, page } = await launch(userData, { AIC_NATIVE_AUDIO: '0' });
  try {
    await nav(page, 'Settings');
    const hotkeys = page.locator('#hotkeys');
    await expect(hotkeys).toContainText('Ctrl + Alt + Space');
    await hotkeys.getByRole('button', { name: /Shortcut Ctrl \+ Alt \+ Space/ }).click();
    await page.keyboard.press('Control+Alt+KeyK');
    await expect(hotkeys).toContainText('Ctrl + Alt + K');
    await hotkeys.getByRole('button', { name: 'Reset' }).click();
    await expect(hotkeys).toContainText('Ctrl + Alt + Space');

    const copilot = page.locator('#copilot');
    await copilot.getByRole('radio', { name: 'Large' }).click();
    await expect(copilot.getByRole('radio', { name: 'Large' })).toHaveAttribute('data-state', 'on');
    await screenshot(page, 'settings-live');
  } finally {
    await app.close();
  }
});

test('built-in capture: a microphone reaches the engine through the capture window', async () => {
  const { app, page } = await launch(userData, { AIC_NATIVE_AUDIO: '0', AIC_FAKE_MEDIA: '1' });
  try {
    await nav(page, 'Audio');
    await page.getByRole('radio', { name: 'Built-in' }).click();
    await expect(page.getByText('In use: Built-in capture.')).toBeVisible();
    await page.getByRole('radio', { name: 'Levels only' }).click();
    await page.getByTestId('start-audio-test').click();
    // Chromium's fake microphone beeps twice a second; poll often enough to catch one.
    await expect
      .poll(async () => Number(await page.getByTestId('meter-you').getAttribute('data-db')), {
        timeout: 20_000,
        intervals: [40],
      })
      .toBeGreaterThan(-60);
    await page.getByRole('button', { name: 'Stop test' }).click();
  } finally {
    await app.close();
  }
});
