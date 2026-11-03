import { AlertDialog as A } from 'radix-ui';
import type { ReactNode } from 'react';
import { Button } from './button';

/** Confirmation dialog for destructive actions. */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy = false,
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <A.Root>
      <A.Trigger asChild>{trigger}</A.Trigger>
      <A.Portal>
        <A.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <A.Content className="fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-2xl">
          <A.Title className="text-base font-semibold">{title}</A.Title>
          <A.Description asChild>
            <div className="mt-2 space-y-2 text-sm text-muted-foreground">{description}</div>
          </A.Description>
          <div className="mt-6 flex justify-end gap-2">
            <A.Cancel asChild>
              <Button variant="secondary">Cancel</Button>
            </A.Cancel>
            <A.Action asChild>
              <Button variant="destructive" loading={busy} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </A.Action>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
