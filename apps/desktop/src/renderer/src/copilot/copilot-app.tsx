import type { Settings } from '@aic/ipc';
import { EyeOff, Pause, Play, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LevelMeter } from '../components/live/level-meter';
import { SuggestionCard } from '../components/live/suggestion-card';
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
  const { state, meter, segments, interim, suggestion } = live;
  const [fontSize, setFontSize] = useState<Settings['copilot']['fontSize']>('medium');
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const elapsed = useElapsed(state);

  useEffect(() => {
    void live.init().catch((err: unknown) => setError(errorMessage(err)));
    void invoke('settings:get')
      .then((s) => setFontSize(s.copilot.fontSize))
      .catch(() => undefined);
    return on('settings:changed', (s) => setFontSize(s.copilot.fontSize));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 3000);
    return () => clearTimeout(t);
  }, [confirmStop]);

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
          Start an interview in the main window. The live transcript and suggestions will appear
          here.
        </div>
      ) : (
        <>
          {suggestion && (
            <div className="shrink-0 border-b border-border p-2">
              <SuggestionCard
                suggestion={suggestion}
                onDismiss={() => useLive.setState({ suggestion: null })}
                className="max-h-[45vh] overflow-y-auto"
              />
            </div>
          )}
          <TranscriptView
            segments={segments}
            interim={interim}
            compact
            className="flex-1 px-3 py-2"
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
