import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { JobState } from '../hooks/use-job';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/** Spinner, the engine's latest progress message, elapsed time, and Cancel. */
export function JobProgress({
  job,
  onCancel,
  className,
}: {
  job: JobState;
  onCancel: () => void;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!job.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job.running]);
  if (!job.running) return null;
  const seconds = job.startedAt ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : 0;
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-accent/50 px-4 py-3',
        className,
      )}
      role="status"
      data-testid="job-progress"
    >
      <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">{job.message ?? 'Working…'}</p>
      <span className="text-xs text-muted-foreground tabular-nums">{seconds}s</span>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
