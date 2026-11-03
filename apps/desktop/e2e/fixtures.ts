import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

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
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-app-ready="true"], [role="alert"]', { timeout: 30_000 });
  return { app, page };
}
