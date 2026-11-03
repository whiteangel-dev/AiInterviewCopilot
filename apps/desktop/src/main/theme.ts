import { nativeTheme } from 'electron';
import type { Theme } from '@aic/ipc';
import { readJsonFile, writeJsonFile } from './json-file';

/** Must match `--background` / `--titlebar-symbol` in the renderer's styles.css. */
const WINDOW_COLORS = {
  light: { background: '#ffffff', symbol: '#3f3f46' },
  dark: { background: '#0e0e11', symbol: '#d4d4d8' },
} as const;

export const TITLEBAR_HEIGHT = 40;

export function windowColors(): { background: string; symbol: string } {
  return nativeTheme.shouldUseDarkColors ? WINDOW_COLORS.dark : WINDOW_COLORS.light;
}

/**
 * Sets the app theme. The renderer follows `prefers-color-scheme`, which tracks
 * `nativeTheme.themeSource`, so this is the single switch for both.
 */
export function applyTheme(theme: Theme): void {
  nativeTheme.themeSource = theme;
}

/** The theme is cached outside the database so the first frame has the right colors. */
export function readCachedTheme(file: string): Theme {
  const cached = readJsonFile(file) as { theme?: unknown } | undefined;
  const theme = cached?.theme;
  return theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system';
}

export function cacheTheme(file: string, theme: Theme): void {
  try {
    writeJsonFile(file, { theme });
  } catch {
    // cosmetic only
  }
}
