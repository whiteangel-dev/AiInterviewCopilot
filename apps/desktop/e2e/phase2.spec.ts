import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { VALID_KEY, launch, removeDir, tempUserData } from './fixtures';

const FIXTURES = resolve(__dirname, '../../../packages/core/fixtures');
const SCREENS = join(__dirname, '..', 'test-results', 'screens');

async function screenshot(page: Page, name: string) {
  mkdirSync(SCREENS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SCREENS, `${name}.png`) });
}

async function addKey(page: Page) {
  await nav(page, 'Settings');
  const card = page.getByTestId('api-key-card');
  await card.getByLabel('API key').fill(VALID_KEY);
  await card.getByRole('button', { name: 'Save key' }).click();
  await expect(card.getByText('Verified')).toBeVisible();
}

async function importResume(page: Page, file = 'resume-jordan-rivera.pdf') {
  await nav(page, 'Profiles');
  await page.getByTestId('resume-file-input').setInputFiles(join(FIXTURES, file));
  await expect(page.getByTestId('profile-editor')).toBeVisible({ timeout: 30_000 });
}

/** Sidebar navigation (the profile page also has a "Profiles" back link). */
const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();

let userData: string;
test.beforeEach(() => {
  userData = tempUserData();
});
test.afterEach(() => removeDir(userData));

test('resume: import a PDF, review what was not found, edit, save, see history', async () => {
  const { app, page } = await launch(userData);
  try {
    await addKey(page);
    await importResume(page);
    await expect(page.getByRole('heading', { name: 'Jordan Rivera', level: 1 })).toBeVisible();
    await expect(page.getByTestId('unverified-banner')).toContainText('1 statement wasn’t found');
    await expect(page.locator('[data-status="verified"]').first()).toBeVisible();
    await screenshot(page, 'profile-editor');

    // Fix the statement that isn't in the resume by deleting it.
    const flagged = page.locator('li', { has: page.locator('[data-status="unverified"]') });
    await flagged.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByTestId('unverified-banner')).toHaveCount(0);
    await page.getByLabel('Headline').fill('Senior Backend Engineer, Payments');
    await page.getByTestId('save-bar').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved as version 2.')).toBeVisible();

    await page.getByRole('tab', { name: 'What the AI sees' }).click();
    await expect(page.getByTestId('brief')).toContainText('Senior Backend Engineer, Payments');
    await expect(page.getByTestId('brief')).not.toContainText('excellence award');
    await page.getByRole('tab', { name: 'History' }).click();
    const history = page.getByRole('tabpanel').locator('li');
    await expect(history).toHaveCount(2);
    await expect(history.first()).toContainText('Current');
    await page.getByRole('tab', { name: 'Resume text' }).click();
    await expect(page.getByText('Pinecrest Labs')).toBeVisible();

    await nav(page, 'Home');
    await expect(page.getByTestId('setup-steps').getByText('2 of 5 done')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('resume: a Word file works, and unsupported files are refused', async () => {
  const { app, page } = await launch(userData);
  try {
    await addKey(page);
    await nav(page, 'Profiles');
    await page.getByTestId('resume-file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    await expect(page.getByRole('alert')).toContainText('PDF or Word');
    await importResume(page, 'resume-jordan-rivera.docx');
    await nav(page, 'Profiles');
    await expect(page.getByTestId('profile-list')).toContainText('resume-jordan-rivera.docx');
  } finally {
    await app.close();
  }
});

test('knowledge: notes, add from text, AI review, and the combined preview', async () => {
  const { app, page } = await launch(userData);
  try {
    await addKey(page);
    await importResume(page);
    await nav(page, 'Knowledge');
    await page.getByLabel('Knowledge base name').fill('Kestrel Pay');
    await page.getByRole('button', { name: 'Create' }).click();

    await page.getByRole('button', { name: 'Add note' }).click();
    const editor = page.getByTestId('item-editor');
    await editor.getByRole('radio', { name: 'Instruction' }).click();
    await editor.getByLabel('Content').fill('Never bring up the 2020 layoffs unless asked.');
    await editor.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByTestId('knowledge-item')).toHaveCount(1);

    await page.getByRole('button', { name: 'Add from text' }).click();
    await page
      .getByLabel('Notes')
      .fill(
        '- My target base salary is $185k to $205k.\n- Never bring up the 2020 layoffs unless asked.\n- I led the Black Friday 2022 incident response.',
      );
    await page.getByRole('button', { name: 'Organize' }).click();
    await expect(page.getByTestId('proposals').locator('li')).toHaveCount(3);
    await page.getByRole('button', { name: 'Add 3 notes' }).click();
    await expect(page.getByTestId('knowledge-item')).toHaveCount(4);

    await page.getByRole('button', { name: 'Review notes' }).click();
    await expect(page.getByTestId('analysis-issue')).toHaveCount(1);
    await expect(page.getByTestId('analysis-issue')).toContainText('Duplicate');
    await screenshot(page, 'knowledge');

    await page.getByRole('button', { name: 'Preview' }).click();
    const preview = page.getByTestId('context-preview');
    await expect(preview).toContainText('CANDIDATE PROFILE');
    await expect(preview).toContainText('Quayside Logistics');
    await expect(preview).toContainText('Answer instructions (follow these)');
    await expect(preview).toContainText('$185k to $205k');
  } finally {
    await app.close();
  }
});

test('answer bank: prepare, approve, and try a question', async () => {
  const { app, page } = await launch(userData);
  try {
    await addKey(page);
    await importResume(page);
    await nav(page, 'Answer bank');
    await page.getByRole('button', { name: 'Prepare answers' }).click();
    await expect(page.getByTestId('answer-card')).toHaveCount(3);
    await expect(page.locator('[data-testid="answer-card"][data-status="draft"]')).toHaveCount(3);

    const intro = page.getByTestId('answer-card').filter({ hasText: 'Tell me about yourself.' });
    await intro.getByRole('button', { name: 'Approve' }).click();
    await expect(intro).toHaveAttribute('data-status', 'approved');

    await page.getByLabel('Test question').fill('So, could you walk me through your background?');
    await page.getByRole('button', { name: 'Match' }).click();
    await expect(page.getByTestId('match-results')).toContainText('Tell me about yourself.');
    await screenshot(page, 'answer-bank');
  } finally {
    await app.close();
  }
});
