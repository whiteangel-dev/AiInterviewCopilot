import type { Settings } from '@aic/ipc';
import { formatAccelerator } from '@aic/ipc/hotkeys';
import { EyeOff, Pause, Play, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AnswerCard } from '../components/live/answer-card';
import { LevelMeter } from '../components/live/level-meter';
import { TranscriptView } from '../components/live/transcript-view';
import { LiveWarnings } from '../components/live/warnings';
import { formatClock, isActive, useElapsed, useLive } from '../live-store';
import { invoke, on } from '../lib/api';
import { cn, errorMessage } from '../lib/utils';

const FONT: Record<Settings['copilot']['fontSize'], string> = {
  small: 'text-[13px]',
  medium: 'text-sm',
  large: 'text-base',
};

function IconButton({
  label,
  onClick,
  children,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'no-drag flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5',
        danger && 'hover:bg-destructive/12 hover:text-destructive',
      )}
    >
      {children}
    </button>
  );
}

export function CopilotApp() {
  const live = useLive();
  const { state, meter, segments, interim, answers, phase } = live;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const elapsed = useElapsed(state);
  const fontSize = settings?.copilot.fontSize ?? 'medium';
  const answerKey = settings?.hotkeys.answerNow;

  useEffect(() => {
    void live.init().catch((err: unknown) => setError(errorMessage(err)));
    void invoke('settings:get')
      .then(setSettings)
      .catch(() => undefined);
    return on('settings:changed', setSettings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 3000);
    return () => clearTimeout(t);
  }, [confirmStop]);

  // Short-lived notices ("nothing to answer yet") clear themselves.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const act = (fn: () => Promise<void>) => () =>
    void fn().catch((err: unknown) => setError(errorMessage(err)));

  const interview = state?.mode === 'interview' ? state : null;
  const active = isActive(interview);
  const status = interview?.status;

  return (
    <div className={cn('flex h-full flex-col', FONT[fontSize])} data-testid="copilot">
      <header className="drag flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            status === 'live'
              ? 'animate-pulse bg-destructive'
              : status === 'paused'
                ? 'bg-warning'
                : 'bg-muted-foreground/40',
          )}
          aria-hidden
        />
        <span className="text-xs font-semibold" data-testid="copilot-status">
          {status === 'live'
            ? 'Listening'
            : status === 'paused'
              ? 'Paused'
              : status === 'ended'
                ? 'Interview ended'
                : 'Not listening'}
        </span>
        {interview && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatClock(elapsed)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {active && status === 'live' && (
            <IconButton label="Pause listening" onClick={act(live.pause)}>
              <Pause />
            </IconButton>
          )}
          {active && status === 'paused' && (
            <IconButton label="Resume listening" onClick={act(live.resume)}>
              <Play />
            </IconButton>
          )}
          {active &&
            (confirmStop ? (
              <button
                type="button"
                onClick={act(async () => {
                  setConfirmStop(false);
                  await live.stop();
                })}
                className="no-drag h-7 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground"
              >
                End interview?
              </button>
            ) : (
              <IconButton label="End interview" onClick={() => setConfirmStop(true)} danger>
                <Square />
              </IconButton>
            ))}
          <IconButton label="Hide copilot" onClick={act(() => live.setCopilotVisible(false))}>
            <EyeOff />
          </IconButton>
        </div>
      </header>

      {error && (
        <div
          className="border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}

      {!interview ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Start an interview in the main window. Answers and the live transcript will appear here.
        </div>
      ) : (
        <>
          <div className="flex min-h-36 flex-[3] p-2 pb-0">
            <AnswerCard
              answers={answers}
              phase={phase}
              live={status === 'live'}
              answerNowHint={answerKey ? formatAccelerator(answerKey, window.aic.platform) : null}
              onAnswerNow={act(live.answerNow)}
              onRegenerate={(id, length) => act(() => live.regenerate(id, length))()}
              className="flex-1"
            />
          </div>
          <TranscriptView
            segments={segments}
            interim={interim}
            compact
            className="min-h-20 flex-[2] px-3 py-2 text-[0.93em]"
            emptyText={status === 'live' ? 'Listening…' : 'No transcript yet.'}
          />
          <footer className="shrink-0 space-y-2 border-t border-border px-3 py-2">
            <LiveWarnings warnings={interview.warnings} />
            {(interview.channels.interviewer.error || interview.channels.candidate.error) && (
              <ul className="space-y-0.5 text-xs text-destructive" role="alert">
                {[interview.channels.interviewer.error, interview.channels.candidate.error]
                  .filter(Boolean)
                  .map((e) => (
                    <li key={e}>{e}</li>
                  ))}
              </ul>
            )}
            <div className="grid grid-cols-2 gap-3">
              <LevelMeter
                label="Interviewer"
                db={meter?.levels.interviewer.db}
                speaking={meter?.levels.interviewer.speaking}
                compact
              />
              <LevelMeter
                label="You"
                db={meter?.levels.candidate.db}
                speaking={meter?.levels.candidate.speaking}
                compact
              />
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
