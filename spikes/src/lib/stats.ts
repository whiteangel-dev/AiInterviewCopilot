/** Nearest-rank percentile (p in 0..100). Returns NaN for empty input. */
export function percentile(values: number[], p: number): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(xs.length - 1, Math.max(0, rank - 1))] ?? Number.NaN;
}

export function mean(values: number[]): number {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
}

export const fmtMs = (v: number) => (Number.isFinite(v) ? `${Math.round(v)} ms` : '—');

/** Renders rows as a fixed-width text table for terminal output. */
export function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, c) => Math.max(...cells.map((r) => (r[c] ?? '').length)));
  const line = (r: string[]) => r.map((v, c) => v.padEnd(widths[c] ?? 0)).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n');
}
