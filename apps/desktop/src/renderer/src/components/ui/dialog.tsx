import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <D.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[min(720px,calc(100vh-48px))] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card shadow-2xl',
            className,
          )}
        >
          <div className="flex items-start gap-4 border-b border-border px-6 py-4">
            <div className="min-w-0 flex-1">
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="mt-1 text-sm text-muted-foreground">
                  {description}
                </D.Description>
              ) : (
                <D.Description className="sr-only">{title}</D.Description>
              )}
            </div>
            <D.Close
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-border px-6 py-3">{footer}</div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
