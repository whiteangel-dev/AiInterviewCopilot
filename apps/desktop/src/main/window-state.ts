import type { Rectangle } from 'electron';
import { readJsonFile, writeJsonFile } from './json-file';

export interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1180, height: 780 };
export const MIN_SIZE = { width: 900, height: 600 };

function isRect(v: unknown): v is Rectangle {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k]));
}

/**
 * Returns the saved state if at least 100×50 px of the window's top would be
 * visible on a current display (displays change between sessions), else null.
 */
export function restoreWindowState(
  file: string,
  workAreas: Rectangle[],
  minSize: { width: number; height: number } = MIN_SIZE,
): WindowState | null {
  const raw = readJsonFile(file) as Partial<WindowState> | undefined;
  if (!raw || !isRect(raw.bounds)) return null;
  const b = raw.bounds;
  const bounds = {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(minSize.width, Math.round(b.width)),
    height: Math.max(minSize.height, Math.round(b.height)),
  };
  const titleStrip = { x: bounds.x, y: bounds.y, width: bounds.width, height: 50 };
  const visible = workAreas.some((area) => {
    const w =
      Math.min(titleStrip.x + titleStrip.width, area.x + area.width) -
      Math.max(titleStrip.x, area.x);
    const h =
      Math.min(titleStrip.y + titleStrip.height, area.y + area.height) -
      Math.max(titleStrip.y, area.y);
    return w >= 100 && h >= 50;
  });
  return visible ? { bounds, maximized: raw.maximized === true } : null;
}

export function saveWindowState(file: string, state: WindowState): void {
  try {
    writeJsonFile(file, state);
  } catch {
    // losing the window position is not worth an error
  }
}
