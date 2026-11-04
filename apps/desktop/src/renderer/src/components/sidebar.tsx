import {
  AudioLines,
  FileText,
  History,
  House,
  MessageSquareQuote,
  NotebookPen,
  Radio,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { isActive, useLive } from '../live-store';
import { cn } from '../lib/utils';
import { useApp, type Page } from '../store';
import { Logo } from './logo';

const NAV: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: 'home', label: 'Home', icon: House },
  { page: 'interview', label: 'Interview', icon: Radio },
  { page: 'sessions', label: 'Sessions', icon: History },
  { page: 'profiles', label: 'Profiles', icon: FileText },
  { page: 'knowledge', label: 'Knowledge', icon: NotebookPen },
  { page: 'answers', label: 'Answer bank', icon: MessageSquareQuote },
  { page: 'audio', label: 'Audio', icon: AudioLines },
  { page: 'settings', label: 'Settings', icon: Settings },
];

const ENGINE_LABEL = {
  starting: { text: 'Starting…', dot: 'bg-warning animate-pulse' },
  ready: { text: 'Ready', dot: 'bg-success' },
  restarting: { text: 'Reconnecting…', dot: 'bg-warning animate-pulse' },
  failed: { text: 'Stopped', dot: 'bg-destructive' },
} as const;

export function Sidebar() {
  const page = useApp((s) => s.page);
  const navigate = useApp((s) => s.navigate);
  const engine = useApp((s) => s.engine);
  const version = useApp((s) => s.info?.version);
  const label = ENGINE_LABEL[engine?.state ?? 'starting'];
  const live = useLive((s) => s.state);
  const liveInterview = live?.mode === 'interview' && isActive(live);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="drag flex h-16 items-center gap-2.5 px-5">
        <Logo className="size-7" />
        <div className="leading-tight">
          <div className="font-display text-sm font-semibold">Interview Copilot</div>
          <div className="text-[11px] text-muted-foreground">AI answers, your experience</div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-2" aria-label="Main">
        {NAV.map(({ page: target, label: text, icon: Icon }) => (
          <button
            key={target}
            type="button"
            onClick={() => navigate(target)}
            aria-current={page === target ? 'page' : undefined}
            className={cn(
              'flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              page === target
                ? 'bg-card text-foreground shadow-xs ring-1 ring-border'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {text}
            {target === 'interview' && liveInterview && (
              <span
                className={cn(
                  'ml-auto size-2 rounded-full',
                  live.status === 'paused' ? 'bg-warning' : 'animate-pulse bg-destructive',
                )}
                aria-label={live.status === 'paused' ? 'Paused' : 'Live'}
                data-testid="nav-live"
              />
            )}
          </button>
        ))}
      </nav>

      <div className="flex items-center justify-between border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <span
          className="flex items-center gap-2"
          data-testid="engine-state"
          data-state={engine?.state}
        >
          <span className={cn('size-2 rounded-full', label.dot)} aria-hidden />
          {label.text}
        </span>
        {version && <span>v{version}</span>}
      </div>
    </aside>
  );
}
