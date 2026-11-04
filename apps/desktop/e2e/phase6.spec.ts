import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { VALID_KEY, launch, nav, removeDir, screenshot, tempUserData } from './fixtures';

let owner: string;
let guest: string;
test.beforeEach(() => {
  owner = tempUserData();
  guest = tempUserData();
});
test.afterEach(() => {
  removeDir(owner);
  removeDir(guest);
});

test('key files: the owner creates one, someone else imports it with the password', async () => {
  const file = join(owner, 'gemini-key-alex.aickey');

  // The owner makes a key file in Settings.
  {
    const { app, page } = await launch(owner);
    try {
      // Stand in for the native save dialog.
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
      }, file);
      await nav(page, 'Settings');
      await page.locator('#share-key').getByRole('button', { name: 'Create key file' }).click();
      const form = page.getByTestId('create-key-file');
      await form.getByLabel('Key to share').fill(VALID_KEY);
      await form.getByLabel("Who it's for").fill('Alex Kim');
      await form.getByLabel('Password', { exact: true }).fill('blue-harbor-42');
      await form.getByLabel('Repeat password').fill('blue-harbor-41');
      await expect(form).toContainText("The passwords don't match.");
      await form.getByLabel('Repeat password').fill('blue-harbor-42');
      await form.getByLabel('Works until').fill('2099-12-31');
      await screenshot(page, 'create-key-file');
      await page.getByRole('button', { name: 'Save key file' }).click();
      await expect(page.getByText('Key file saved.')).toBeVisible();
    } finally {
      await app.close();
    }
  }
  expect(existsSync(file)).toBe(true);
  // The key isn't in the file in plain text.
  expect(readFileSync(file, 'utf8')).not.toContain(VALID_KEY);

  // Someone else imports it on their computer.
  const { app, page } = await launch(guest);
  try {
    const steps = page.getByTestId('setup-steps');
    await steps.getByRole('button', { name: /Someone gave you a key file/ }).click();
    const importer = steps.getByTestId('key-file-import');
    await importer.getByLabel('Key file').setInputFiles(file);
    await expect(importer.getByTestId('key-file-name')).toHaveText('gemini-key-alex.aickey');
    await importer.getByLabel('Key file password').fill('wrong password');
    await importer.getByRole('button', { name: 'Import' }).click();
    await expect(importer.getByRole('alert')).toContainText("That password doesn't open");
    await importer.getByLabel('Key file password').fill('blue-harbor-42');
    await importer.getByRole('button', { name: 'Import' }).click();
    await expect(steps.getByText('1 of 5 done')).toBeVisible();

    await nav(page, 'Settings');
    const card = page.getByTestId('api-key-card');
    await expect(card.getByText('Verified')).toBeVisible();
    await expect(card.getByTestId('key-origin')).toContainText(
      'From a key file (Alex Kim), works until Dec 31, 2099',
    );
    await screenshot(page, 'key-file-imported');
  } finally {
    await app.close();
  }
});
