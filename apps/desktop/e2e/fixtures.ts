import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

export const APP_DIR = resolve(__dirname, '..');

/** Fake keys understood by the offline FakeProvider (AIC_FAKE_PROVIDER=1). */
export const VALID_KEY = ['AIza', 'E2E', 'x'.repeat(28), 'abcd'].join('');
export const INVALID_KEY = ['AIza', 'INVALID', 'x'.repeat(28)].join('');

export function tempUserData(): string {
  return mkdtempSync(join(tmpdir(), 'aic-e2e-'));
}

export function removeDir(dir: string): void {
  // Windows may hold files briefly after the app exits.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export async function launch(
  userDataDir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // Editors built on Electron (VS Code) set this; it would start Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    // Let the app's own theme (nativeTheme.themeSource) drive prefers-color-scheme.
    colorScheme: null,
    args: [APP_DIR, ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])],
    env: {
      ...env,
      AIC_USER_DATA_DIR: userDataDir,
      AIC_FAKE_PROVIDER: '1',
      // No OS keyring prompts on Linux dev machines and CI.
      ...(process.platform === 'linux' ? { AIC_PASSWORD_STORE: 'basic' } : {}),
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-app-ready="true"], [role="alert"]', { timeout: 30_000 });
  return { app, page };
}

const SCREENS = join(__dirname, '..', 'test-results', 'screens');

export async function screenshot(page: Page, name: string) {
  mkdirSync(SCREENS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SCREENS, `${name}.png`) });
}

export const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();

export async function addKey(page: Page) {
  await nav(page, 'Settings');
  const card = page.getByTestId('api-key-card');
  await card.getByLabel('API key').fill(VALID_KEY);
  await card.getByRole('button', { name: 'Save key' }).click();
  await expect(card.getByText('Verified')).toBeVisible();
}

/** A 16 kHz mono WAV of silence and tone bursts (stand-ins for speech). */
export function writeSpeechWav(file: string, pattern: [silenceMs: number, speechMs: number][]) {
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

export async function copilotWindow(app: ElectronApplication): Promise<Page> {
  const existing = app.windows().find((w) => w.url().includes('copilot.html'));
  if (existing) return existing;
  return app.waitForEvent('window', { predicate: (w) => w.url().includes('copilot.html') });
}
