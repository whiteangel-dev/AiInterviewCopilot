import type { AnswerIssue, AnswerLength, LiveAnswer, TurnPhase } from '@aic/ipc';
import {
  BookCheck,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  RotateCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';

const SHORTER: Record<AnswerLength, AnswerLength | null> = {
  short: null,
  standard: 'short',
  detailed: 'standard',
};
const LONGER: Record<AnswerLength, AnswerLength | null> = {
  short: 'standard',
  standard: 'detailed',
  detailed: null,
};

/** Marks the words the fact check flagged. */
function marked(line: string, issues: readonly AnswerIssue[]): React.ReactNode {
  const hits: { start: number; end: number; issue: AnswerIssue }[] = [];
  for (const issue of issues) {
    const start = line.indexOf(issue.quote);
    if (start >= 0) hits.push({ start, end: start + issue.quote.length, issue });
  }
  if (hits.length === 0) return line;
  hits.sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue;
    out.push(line.slice(at, h.start));
    out.push(
      <mark
        key={h.start}
        title={h.issue.problem}
        className="rounded-sm bg-warning/20 text-inherit underline decoration-warning decoration-dotted underline-offset-2"
      >
        {line.slice(h.start, h.end)}
      </mark>,
    );
    at = h.end;
  }
  out.push(line.slice(at));
  return out;
}

/**
 * An answer in the copilot's format: the first line is a sentence to start
 * with, then bullets ("- ") in the order to say them. Words the fact check
 * flagged are marked.
 */
export function AnswerText({
  text,
  streaming = false,
  issues = [],
  className,
}: {
  text: string;
  streaming?: boolean;
  issues?: readonly AnswerIssue[];
  className?: string;
}) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const [first, ...rest] = lines;
  const caret = streaming && (
    <span
      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-primary"
      aria-hidden
    />
  );
  return (
    <div className={cn('space-y-1.5 leading-snug', className)} data-testid="answer-text">
      {first && (
        <p className="text-[1.07em] font-medium">
          {marked(first.replace(/^- /, ''), issues)}
          {rest.length === 0 && caret}
        </p>
      )}
      {rest.length > 0 && (
        <ul className="space-y-1">
          {rest.map((line, i) => {
            const bullet = line.startsWith('- ');
            return (
              <li key={i} className={cn(bullet && 'flex gap-2')}>
                {bullet && (
                  <span className="mt-[0.55em] size-1.5 shrink-0 rounded-full bg-primary/70" />
                )}
                <span>
                  {marked(bullet ? line.slice(2) : line, issues)}
                  {i === rest.length - 1 && caret}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {!first && caret}
    </div>
  );
}

/** What the fact check found that the profile and notes don't support. */
export function AnswerIssues({ issues }: { issues: readonly AnswerIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div
      className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs"
      data-testid="answer-issues"
      role="note"
    >
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-warning">
        <TriangleAlert className="size-3.5" aria-hidden /> Not in your profile or notes
      </div>
      <ul className="space-y-1">
        {issues.map((issue) => (
          <li key={issue.quote}>
            <span className="font-medium">“{issue.quote}”</span>: {issue.problem}
            {issue.fix && <span className="text-muted-foreground"> Your notes: {issue.fix}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Action({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

/**
 * The live answer to the interviewer's latest question, with earlier answers
 * a click away. Follows new answers unless the reader went back to an older one.
 */
export function AnswerCard({
  answers,
  phase,
  live,
  answerNowHint,
  onAnswerNow,
  onRegenerate,
  className,
}: {
  answers: readonly LiveAnswer[];
  phase: TurnPhase;
  /** Listening (not paused or ended). */
  live: boolean;
  /** e.g. "Ctrl + Alt + Enter" */
  answerNowHint: string | null;
  onAnswerNow: () => void;
  onRegenerate: (answerId: string, length: AnswerLength | null) => void;
  className?: string;
}) {
  const [pinned, setPinned] = useState<string | null>(null);
  const pinnedIndex = pinned ? answers.findIndex((a) => a.id === pinned) : -1;
  const index = pinnedIndex >= 0 ? pinnedIndex : answers.length - 1;
  const answer = answers[index];
  const go = (i: number) => setPinned(i >= answers.length - 1 ? null : (answers[i]?.id ?? null));
  const status =
    phase === 'thinking' ? 'Thinking…' : phase === 'listening' && live ? 'Listening…' : null;

  return (
    <section
      className={cn('flex min-h-0 flex-col rounded-lg border border-border bg-card', className)}
      aria-label="Suggested answer"
      data-testid="answer-card"
      data-phase={phase}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Sparkles className="size-3.5 text-primary" aria-hidden />
        <span className="text-[11px] font-semibold tracking-wide text-primary uppercase">
          Answer
        </span>
        {status && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn(
                'size-1.5 rounded-full',
                phase === 'thinking' ? 'animate-pulse bg-primary' : 'bg-muted-foreground/50',
              )}
              aria-hidden
            />
            {status}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {answers.length > 1 && (
            <>
              <Action label="Previous answer" onClick={() => go(index - 1)} disabled={index <= 0}>
                <ChevronLeft />
              </Action>
              <span
                className="text-xs text-muted-foreground tabular-nums"
                data-testid="answer-position"
              >
                {index + 1}/{answers.length}
              </span>
              <Action
                label="Next answer"
                onClick={() => go(index + 1)}
                disabled={index >= answers.length - 1}
              >
                <ChevronRight />
              </Action>
            </>
          )}
          <button
            type="button"
            onClick={onAnswerNow}
            title={answerNowHint ? `Answer now (${answerNowHint})` : 'Answer now'}
            className="ml-1 h-7 rounded-md bg-primary/10 px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
            data-testid="answer-now"
          >
            Answer now
          </button>
        </div>
      </header>

      {!answer ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[13px] text-muted-foreground">
          {live
            ? 'When the interviewer asks a question, an answer appears here.'
            : 'No answers yet.'}
        </div>
      ) : (
        <>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5"
            data-testid="answer"
            data-status={answer.status}
          >
            <p className="mb-2 line-clamp-2 text-xs text-muted-foreground" title={answer.question}>
              {answer.question}
            </p>
            {answer.source === 'bank' && (
              <Badge tone="accent" className="mb-2">
                <BookCheck aria-hidden /> From your answer bank
              </Badge>
            )}
            {answer.text && (
              <AnswerText
                text={answer.text}
                streaming={answer.status === 'streaming'}
                issues={answer.check?.issues}
              />
            )}
            {answer.check?.status === 'issues' && <AnswerIssues issues={answer.check.issues} />}
            {answer.status === 'error' && (
              <p
                className="mt-1 flex items-start gap-1.5 text-[13px] text-destructive"
                role="alert"
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {answer.error ?? "Couldn't write an answer."}
              </p>
            )}
            {answer.status === 'stopped' && (
              <p className="mt-1 text-xs text-muted-foreground">Stopped.</p>
            )}
            {index < answers.length - 1 && (
              <button
                type="button"
                onClick={() => setPinned(null)}
                className="mt-2 text-xs font-medium text-primary hover:underline"
              >
                Latest answer ›
              </button>
            )}
          </div>
          <footer className="flex h-9 shrink-0 items-center gap-1 border-t border-border px-2">
            <span className="px-1 text-[11px] text-muted-foreground tabular-nums">
              {answer.latencyMs !== null
                ? `${(answer.latencyMs / 1000).toFixed(1)} s`
                : answer.trigger === 'regenerate'
                  ? 'Rewritten'
                  : answer.trigger === 'manual'
                    ? 'On request'
                    : ''}
            </span>
            {answer.check && answer.check.status !== 'error' && (
              <span
                className={cn(
                  'flex items-center gap-1 px-1 text-[11px]',
                  answer.check.status === 'ok' && 'text-success',
                  answer.check.status === 'issues' && 'font-medium text-warning',
                  answer.check.status === 'checking' && 'text-muted-foreground',
                )}
                data-testid="answer-check"
                data-check={answer.check.status}
                title="Checked against your profile and notes"
              >
                {answer.check.status === 'checking' ? (
                  'Checking…'
                ) : answer.check.status === 'ok' ? (
                  <>
                    <ShieldCheck className="size-3" aria-hidden /> Checked
                  </>
                ) : (
                  <>
                    <TriangleAlert className="size-3" aria-hidden />
                    {answer.check.issues.length} to check
                  </>
                )}
              </span>
            )}
            <div className="ml-auto flex items-center">
              <Action
                label="Shorter"
                onClick={() => onRegenerate(answer.id, SHORTER[answer.length])}
                disabled={!SHORTER[answer.length]}
              >
                <Minus /> Shorter
              </Action>
              <Action
                label="Longer"
                onClick={() => onRegenerate(answer.id, LONGER[answer.length])}
                disabled={!LONGER[answer.length]}
              >
                <Plus /> Longer
              </Action>
              <Action
                label={answer.source === 'bank' ? 'Write a new answer' : 'Regenerate'}
                onClick={() => onRegenerate(answer.id, null)}
              >
                <RotateCw /> {answer.status === 'error' ? 'Try again' : 'Regenerate'}
              </Action>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
