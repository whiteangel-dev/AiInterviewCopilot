import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useApp } from '../store';

const ICONS = { success: CircleCheck, error: CircleAlert, info: Info };

export function Toaster() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div
      className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-96 flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-lg"
          >
            <Icon
              className={cn(
                'mt-0.5 size-4 shrink-0',
                t.kind === 'success' && 'text-success',
                t.kind === 'error' && 'text-destructive',
                t.kind === 'info' && 'text-primary',
              )}
              aria-hidden
            />
            <p className="flex-1">{t.message}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
