import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const relative = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

/** "just now", "5 minutes ago", "yesterday", … */
export function timeAgo(epochMs: number, now = Date.now()): string {
  const seconds = Math.round((epochMs - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86_400), 'day');
}

/** "Nov 30, 2026" */
export function dateText(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { dateStyle: 'medium' });
}
