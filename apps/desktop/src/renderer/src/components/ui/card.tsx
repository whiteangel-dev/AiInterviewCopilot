import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn('rounded-xl border border-border bg-card shadow-xs', className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-3 px-6 pt-5 pb-4">
      {icon && (
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground [&_svg]:size-4">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] leading-6 font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </header>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-6 pb-6', className)} {...props} />;
}

/** A labelled settings row: text on the left, control on the right. */
export function Field({
  label,
  description,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-6 border-t border-border py-3.5 first:border-t-0 first:pt-0 last:pb-0',
        className,
      )}
    >
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
