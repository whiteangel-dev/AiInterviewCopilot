import type { AudioChannel, TranscriptSegment } from '@aic/ipc';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatClock } from '../../live-store';
import { cn } from '../../lib/utils';

const WHO: Record<AudioChannel, string> = { interviewer: 'Interviewer', candidate: 'You' };

/**
 * The conversation so far: final segments plus each channel's words in
 * progress. Follows new text unless the reader has scrolled up.
 */
export function TranscriptView({
  segments,
  interim = {},
  compact = false,
  emptyText = 'The transcript will appear here.',
  className,
}: {
  segments: readonly TranscriptSegment[];
  interim?: Partial<Record<AudioChannel, TranscriptSegment>>;
  compact?: boolean;
  emptyText?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const pending = Object.values(interim).sort((a, b) => a.startMs - b.startMs);
  const lastText = pending.map((p) => p.text).join('|');

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [segments.length, lastText, follow]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const rows = [
    ...segments.map((s) => ({ s, interim: false })),
    ...pending.map((s) => ({ s, interim: true })),
  ];

  return (
    <div
      ref={ref}
      className={cn('min-h-0 overflow-y-auto', className)}
      data-testid="transcript"
      aria-live="polite"
    >
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ol className={cn(compact ? 'space-y-2' : 'space-y-3')}>
          {rows.map(({ s, interim: pendingRow }) => (
            <li
              key={s.id}
              data-channel={s.channel}
              data-interim={pendingRow ? 'true' : undefined}
              className={cn(
                'rounded-lg',
                s.channel === 'interviewer' ? '' : 'pl-4',
                compact ? '' : 'px-1',
              )}
            >
              <div className="flex items-baseline gap-2 text-[11px] text-muted-foreground">
                <span
                  className={cn(
                    'font-semibold tracking-wide uppercase',
                    s.channel === 'interviewer' ? 'text-primary' : '',
                  )}
                >
                  {WHO[s.channel]}
                </span>
                <span>{formatClock(s.startMs)}</span>
              </div>
              <p
                className={cn(
                  'leading-snug',
                  s.channel === 'candidate' && 'text-muted-foreground',
                  pendingRow && 'italic opacity-70',
                )}
              >
                {s.text}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
