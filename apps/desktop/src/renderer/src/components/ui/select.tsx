import { Check, ChevronDown } from 'lucide-react';
import { Select as S } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface SelectOption {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
}

export function Select({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  id,
  className,
  'aria-label': ariaLabel,
}: {
  value: string | undefined;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <S.Root value={value} onValueChange={onChange} disabled={disabled}>
      <S.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'inline-flex h-9 w-64 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground',
          className,
        )}
      >
        <span className="truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon>
          <ChevronDown className="size-4 opacity-60" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-[min(var(--radix-select-content-available-height),360px)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-card shadow-lg"
        >
          <S.Viewport className="p-1">
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted"
              >
                <S.ItemText>{o.label}</S.ItemText>
                {o.hint && <span className="ml-auto text-xs text-muted-foreground">{o.hint}</span>}
                <S.ItemIndicator className="absolute right-2 inline-flex">
                  <Check className="size-4" />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
