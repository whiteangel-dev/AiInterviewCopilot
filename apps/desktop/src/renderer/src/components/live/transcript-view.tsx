import type { AudioChannel, SessionAnswer, TranscriptSegment } from '@aic/ipc';
import { BookCheck, Sparkles } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatClock } from '../../live-store';
import { cn } from '../../lib/utils';
import { AnswerIssues, AnswerText } from './answer-card';

const WHO: Record<AudioChannel, string> = { interviewer: 'Interviewer', candidate: 'You' };

type Row =
  | { kind: 'segment'; s: TranscriptSegment; interim: boolean; at: number }
  | {
      kind: 'answer';
      a: Pick<SessionAnswer, 'id' | 'text' | 'source' | 'status' | 'trigger' | 'check'>;
      at: number;
    };

/**
 * The conversation so far: final segments plus each channel's words in
 * progress, and (for saved sessions) the answers shown, after each question.
 * Follows new text unless the reader has scrolled up.
 */
export function TranscriptView({
  segments,
  interim = {},
  answers = [],
  compact = false,
  emptyText = 'The transcript will appear here.',
  className,
}: {
  segments: readonly TranscriptSegment[];
  interim?: Partial<Record<AudioChannel, TranscriptSegment>>;
  answers?: readonly Pick<
    SessionAnswer,
    'id' | 'text' | 'source' | 'status' | 'askedAtMs' | 'trigger' | 'check'
  >[];
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

  const rows: Row[] = [
    ...segments.map((s): Row => ({ kind: 'segment', s, interim: false, at: s.startMs })),
    // An answer goes after the question it answers, before the reply.
    ...answers.map((a): Row => ({ kind: 'answer', a, at: a.askedAtMs + 1 })),
  ].sort((x, y) => x.at - y.at);
  for (const s of pending) rows.push({ kind: 'segment', s, interim: true, at: s.startMs });

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
          {rows.map((row) =>
            row.kind === 'answer' ? (
              <li
                key={`answer-${row.a.id}`}
                className="ml-4 rounded-lg border border-primary/20 bg-accent/40 px-3 py-2"
                data-testid="transcript-answer"
              >
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-primary uppercase">
                  {row.a.source === 'bank' ? (
                    <BookCheck className="size-3" aria-hidden />
                  ) : (
                    <Sparkles className="size-3" aria-hidden />
                  )}
                  {row.a.trigger === 'regenerate'
                    ? 'Rewritten answer'
                    : row.a.source === 'bank'
                      ? 'Suggested (answer bank)'
                      : 'Suggested answer'}
                </div>
                {row.a.text ? (
                  <>
                    <AnswerText
                      text={row.a.text}
                      issues={row.a.check?.issues}
                      className="text-[0.95em]"
                    />
                    {row.a.check?.status === 'issues' && (
                      <AnswerIssues issues={row.a.check.issues} />
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {row.a.status === 'error' ? "Couldn't write an answer." : 'Empty.'}
                  </p>
                )}
              </li>
            ) : (
              <SegmentRow key={row.s.id} s={row.s} pendingRow={row.interim} compact={compact} />
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function SegmentRow({
  s,
  pendingRow,
  compact,
}: {
  s: TranscriptSegment;
  pendingRow: boolean;
  compact: boolean;
}) {
  return (
    <li
      data-channel={s.channel}
      data-interim={pendingRow ? 'true' : undefined}
      className={cn('rounded-lg', s.channel === 'interviewer' ? '' : 'pl-4', compact ? '' : 'px-1')}
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
  );
}
