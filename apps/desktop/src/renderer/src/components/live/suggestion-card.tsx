import type { LiveSuggestion } from '@aic/ipc';
import { Lightbulb, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';

/** A prepared answer from the answer bank that matches what was just asked. */
export function SuggestionCard({
  suggestion,
  onDismiss,
  className,
}: {
  suggestion: LiveSuggestion;
  onDismiss?: () => void;
  className?: string;
}) {
  const { answer } = suggestion;
  return (
    <section
      className={cn('rounded-lg border border-primary/30 bg-accent/60 p-3', className)}
      data-testid="suggestion"
      aria-label="Prepared answer"
    >
      <header className="flex items-start gap-2">
        <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold tracking-wide text-primary uppercase">
            From your answer bank
            {answer.status === 'draft' && <Badge tone="warning">Draft</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{answer.question}</p>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        )}
      </header>
      <div className="mt-2 text-sm leading-snug whitespace-pre-line">{answer.answer}</div>
    </section>
  );
}
