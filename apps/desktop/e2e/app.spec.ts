import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { INVALID_KEY, VALID_KEY, launch, removeDir, tempUserData } from './fixtures';

const SCREENS = join(__dirname, '..', 'test-results', 'screens');

async function screenshot(page: Page, name: string) {
  mkdirSync(SCREENS, { recursive: true });
  await page.waitForTimeout(400); // let color transitions settle after a theme change
  await page.screenshot({ path: join(SCREENS, `${name}.png`) });
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
}

let userData: string;
test.beforeEach(() => {
  userData = tempUserData();
});
test.afterEach(() => removeDir(userData));

test('first run: setup steps, engine ready, encrypted database', async () => {
  const { app, page } = await launch(userData);
  try {
    await expect(page.getByTestId('engine-state')).toHaveAttribute('data-state', 'ready');
    const steps = page.getByTestId('setup-steps');
    await expect(steps.getByText('0 of 4 done')).toBeVisible();
    await expect(steps.getByRole('button', { name: 'Add API key' })).toBeVisible();
    await screenshot(page, 'home-first-run');

    const header = readFileSync(join(userData, 'data', 'app.db')).subarray(0, 16);
    expect(header.toString('latin1')).not.toContain('SQLite format 3');
  } finally {
    await app.close();
  }
});

test('API key: rejects a bad key, saves a good one, survives restart, never stored in plaintext', async () => {
  let { app, page } = await launch(userData);
  try {
    await page.getByRole('button', { name: 'Add API key' }).click();
    const card = page.getByTestId('api-key-card');
    await expect(card.getByText('Not set')).toBeVisible();

    await card.getByLabel('API key').fill(INVALID_KEY);
    await card.getByRole('button', { name: 'Save key' }).click();
    await expect(card.getByRole('alert')).toContainText('rejected');
    await expect(card.getByText('Not set')).toBeVisible();

    await card.getByLabel('API key').fill(VALID_KEY);
    await card.getByRole('button', { name: 'Save key' }).click();
    await expect(card.getByText('Verified')).toBeVisible();
    await expect(card.getByTestId('api-key-hint')).toContainText('abcd');

    const models = page.getByTestId('models-card');
    await expect(models.getByText(/models available to your key/)).toBeVisible();
    await expect(models.getByLabel('Answers: Fast')).toContainText('gemini-3.5-flash-lite');
    await expect(models.getByLabel('Answers: Fast')).toBeEnabled();
    await screenshot(page, 'settings-api-key');
  } finally {
    await app.close();
  }

  for (const file of filesUnder(userData)) {
    expect(readFileSync(file).includes(VALID_KEY), `key found in ${file}`).toBe(false);
  }

  ({ app, page } = await launch(userData));
  try {
    await expect(page.getByTestId('setup-steps').getByText('1 of 4 done')).toBeVisible();
    await openSettings(page);
    const card = page.getByTestId('api-key-card');
    await expect(card.getByText('Verified')).toBeVisible();
    await expect(card.getByTestId('api-key-hint')).toContainText('abcd');
  } finally {
    await app.close();
  }
});

test('settings persist across restarts and drive the theme', async () => {
  let { app, page } = await launch(userData);
  try {
    await openSettings(page);
    await page.getByRole('radio', { name: 'Light' }).click();
    await expect
      .poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
      .toBe(false);
    await screenshot(page, 'settings-light');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect
      .poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
      .toBe(true);
    await page.getByRole('radio', { name: 'Quality' }).click();
    await screenshot(page, 'settings-dark');
    await page.getByRole('button', { name: 'Home' }).click();
    await screenshot(page, 'home-dark');
  } finally {
    await app.close();
  }

  ({ app, page } = await launch(userData));
  try {
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(
      true,
    );
    await openSettings(page);
    await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('data-state', 'on');
    await expect(page.getByRole('radio', { name: 'Quality' })).toHaveAttribute('data-state', 'on');
  } finally {
    await app.close();
  }
});

test('renderer is isolated and IPC input is validated', async () => {
  const { app, page } = await launch(userData);
  try {
    const probe = await page.evaluate(async () => {
      const w = window as unknown as Record<string, unknown> & {
        aic: { invoke(c: string, i?: unknown): Promise<unknown> };
      };
      const badPatch = await w.aic.invoke('settings:update', { appearance: { theme: 'neon' } });
      const extraField = await w.aic.invoke('apiKey:save', {
        provider: 'gemini',
        key: 'x'.repeat(30),
        extra: true,
      });
      const badLink = await w.aic.invoke('app:openExternal', 'https://evil.example/');
      let unknownChannel = 'resolved';
      try {
        await w.aic.invoke('shell:exec', 'calc');
      } catch {
        unknownChannel = 'rejected';
      }
      return {
        require: typeof w.require,
        process: typeof w.process,
        bridge: Object.keys(w.aic).sort(),
        badPatch,
        extraField,
        badLink,
        unknownChannel,
      };
    });
    expect(probe.require).toBe('undefined');
    expect(probe.process).toBe('undefined');
    expect(probe.bridge).toEqual(['invoke', 'on', 'platform']);
    for (const result of [probe.badPatch, probe.extraField, probe.badLink]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    }
    expect(probe.unknownChannel).toBe('rejected');
  } finally {
    await app.close();
  }
});

test('missing database key shows recovery, and "Start fresh" recovers', async () => {
  const first = await launch(userData);
  await first.app.close();
  rmSync(join(userData, 'secrets.json'));

  const { app, page } = await launch(userData);
  try {
    await expect(
      page.getByRole('heading', { name: "Your local data can't be opened" }),
    ).toBeVisible();
    await screenshot(page, 'fatal-db-key');
    await page.getByRole('button', { name: 'Start fresh' }).click();
    await page.getByRole('button', { name: 'Delete and start fresh' }).click();
    await expect(page.getByTestId('setup-steps')).toBeVisible();
    await expect(page.getByTestId('engine-state')).toHaveAttribute('data-state', 'ready');
  } finally {
    await app.close();
  }
});

test('"Delete all local data" wipes the key and settings', async () => {
  const { app, page } = await launch(userData);
  try {
    await openSettings(page);
    const card = page.getByTestId('api-key-card');
    await card.getByLabel('API key').fill(VALID_KEY);
    await card.getByRole('button', { name: 'Save key' }).click();
    await expect(card.getByText('Verified')).toBeVisible();
    await page.getByRole('radio', { name: 'Detailed' }).click();

    await page.getByRole('button', { name: 'Delete…' }).click();
    await page.getByRole('button', { name: 'Delete everything' }).click();

    await expect(card.getByText('Not set')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Standard' })).toHaveAttribute('data-state', 'on');
  } finally {
    await app.close();
  }
});
