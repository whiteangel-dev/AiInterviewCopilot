import type { ReactNode } from 'react';

export function Page({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-10 pt-2 pb-16">
      <header className="mb-7">
        <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
      </header>
      <div className="space-y-5">{children}</div>
    </div>
  );
}
