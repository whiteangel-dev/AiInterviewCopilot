/** Rough token estimate for English prose (≈ 4 characters per token). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** "2021-03" → "Mar 2021"; "2015" stays; anything else is shown as written. */
export function formatMonth(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m) return value.trim();
  const month = new Date(Date.UTC(2000, Number(m[2]) - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  return `${month} ${m[1]}`;
}

export function dateRange(start: string | null, end: string | null, current: boolean): string {
  const from = formatMonth(start);
  const to = current ? 'present' : formatMonth(end);
  if (from && to) return `${from} – ${to}`;
  return from ?? to ?? '';
}
