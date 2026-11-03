import { Tabs as T } from 'radix-ui';
import type { ReactNode } from 'react';

export function Tabs({
  value,
  onValueChange,
  tabs,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: ReactNode; content: ReactNode }[];
}) {
  return (
    <T.Root value={value} onValueChange={onValueChange}>
      <T.List className="mb-5 flex gap-1 border-b border-border" aria-label="Sections">
        {tabs.map((t) => (
          <T.Trigger
            key={t.value}
            value={t.value}
            className="-mb-px border-b-2 border-transparent px-3 pb-2.5 text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
          >
            {t.label}
          </T.Trigger>
        ))}
      </T.List>
      {tabs.map((t) => (
        <T.Content key={t.value} value={t.value} className="outline-none">
          {t.content}
        </T.Content>
      ))}
    </T.Root>
  );
}
