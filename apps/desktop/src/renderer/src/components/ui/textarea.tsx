import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/** Grows with its content (up to `maxRows`). */
export function Textarea({
  className,
  autoGrow = true,
  maxRows = 16,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { autoGrow?: boolean; maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !autoGrow) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight + 2, line * maxRows + 16)}px`;
  }, [props.value, autoGrow, maxRows]);
  return (
    <textarea
      ref={ref}
      rows={props.rows ?? 2}
      className={cn(
        'w-full min-w-0 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed shadow-xs transition-colors outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
