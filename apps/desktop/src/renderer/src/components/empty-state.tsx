import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-8 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Icon className="size-5" aria-hidden />
      </div>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      {children && <div className="mt-1.5 max-w-md text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
