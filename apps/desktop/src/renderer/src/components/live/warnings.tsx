import { TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/utils';

export function LiveWarnings({
  warnings,
  className,
}: {
  warnings: readonly string[];
  className?: string;
}) {
  if (warnings.length === 0) return null;
  return (
    <ul className={cn('space-y-1', className)} role="status" data-testid="live-warnings">
      {warnings.map((w) => (
        <li key={w} className="flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{w}</span>
        </li>
      ))}
    </ul>
  );
}
