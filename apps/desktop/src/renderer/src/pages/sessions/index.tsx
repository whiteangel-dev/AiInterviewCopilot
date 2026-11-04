import type { SessionCost, SessionDetail, SessionSummary } from '@aic/ipc';
import {
  ArrowLeft,
  ClipboardCopy,
  Download,
  History,
  Loader2,
  Pencil,
  Radio,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyState } from '../../components/empty-state';
import { TranscriptView } from '../../components/live/transcript-view';
import { Page } from '../../components/page';
import { ConfirmDialog } from '../../components/ui/alert-dialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { formatClock, useLive } from '../../live-store';
import { invoke } from '../../lib/api';
import { errorMessage } from '../../lib/utils';
import { useApp } from '../../store';
import { BACKEND_LABEL } from '../../lib/labels';

const when = (ms: number) =>
  new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

function StatusBadge({ status }: { status: SessionSummary['status'] }) {
  if (status === 'live') return <Badge tone="danger">Live</Badge>;
  if (status === 'interrupted') return <Badge tone="warning">Interrupted</Badge>;
  return null;
}

function SessionList() {
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const liveId = useLive((s) => s.state?.id);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);

  useEffect(() => {
    invoke('sessions:list')
      .then(setSessions)
      .catch((err: unknown) => toast('error', `Couldn't load sessions: ${errorMessage(err)}`));
  }, [toast, liveId]);

  if (!sessions) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No interviews yet"
        action={
          <Button onClick={() => navigate('interview')}>
            <Radio aria-hidden /> Start an interview
          </Button>
        }
      >
        Transcripts of your interviews appear here.
      </EmptyState>
    );
  }
  return (
    <Card>
      <ul data-testid="session-list">
        {sessions.map((s) => (
          <li key={s.id} className="border-t border-border first:border-t-0">
            <button
              type="button"
              onClick={() => navigate('sessions', { sessionId: s.id })}
              className="flex w-full items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">{s.title}</span>
                  <StatusBadge status={s.status} />
                </div>
                <div className="mt-0.5 truncate text-[13px] text-muted-foreground">
                  {[
                    when(s.startedAt),
                    formatClock(s.durationMs),
                    s.profileName,
                    s.knowledgeBaseName,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <span className="text-right text-xs text-muted-foreground">
                {s.segmentCount} line{s.segmentCount === 1 ? '' : 's'}
                {s.answerCount > 0 && (
                  <>
                    <br />
                    {s.answerCount} answer{s.answerCount === 1 ? '' : 's'}
                  </>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const usd = (n: number) => (n < 0.01 ? '<$0.01' : '$' + n.toFixed(2));

/** What the session cost on the user's Gemini key, estimated. */
function CostNote({ cost, stats }: { cost: SessionCost; stats: SessionDetail['stats'] }) {
  const requests = Object.values(stats?.usage?.models ?? {}).reduce((n, u) => n + u.requests, 0);
  const minutes = stats
    ? Math.round((stats.audioSeconds.interviewer + stats.audioSeconds.candidate) / 6) / 10
    : 0;
  return (
    <p className="mt-4 text-xs text-muted-foreground" data-testid="session-cost">
      Estimated cost on your Gemini key: <span className="font-medium">{usd(cost.totalUsd)}</span> (
      {cost.transcriptionUsd !== null && 'transcription ' + usd(cost.transcriptionUsd) + ', '}
      answers {usd(cost.modelsUsd)}; {minutes} min of speech transcribed, {requests} model
      requests). Prices as of {cost.pricesChecked}
      {cost.unpriced.length > 0 && '; no price known for ' + cost.unpriced.join(', ')}.
    </p>
  );
}

function SessionView({ id }: { id: string }) {
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [showAnswers, setShowAnswers] = useState(true);

  useEffect(() => {
    invoke('sessions:get', { id })
      .then(setSession)
      .catch((err: unknown) => {
        toast('error', errorMessage(err));
        navigate('sessions');
      });
  }, [id, navigate, toast]);

  if (!session) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-label="Loading" />
      </div>
    );
  }

  const rename = async () => {
    const next = title.trim();
    setEditing(false);
    if (!next || next === session.title) return;
    try {
      const updated = await invoke('sessions:rename', { id, title: next });
      setSession({ ...session, title: updated.title });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const withAnswers = showAnswers && session.answers.length > 0;

  const save = async (format: 'markdown' | 'text') => {
    try {
      const { saved } = await invoke('sessions:saveTranscript', {
        id,
        format,
        includeAnswers: withAnswers,
      });
      if (saved) toast('success', 'Transcript saved.');
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const copy = async () => {
    try {
      const lines = session.segments.map((s) => ({
        at: s.startMs,
        text: `[${formatClock(s.startMs)}] ${s.channel === 'interviewer' ? 'Interviewer' : 'You'}: ${s.text}`,
      }));
      if (withAnswers) {
        for (const a of session.answers) {
          lines.push({
            at: a.askedAtMs + 1,
            text: `    Suggested answer:\n${a.text
              .split('\n')
              .map((l) => `    ${l}`)
              .join('\n')}`,
          });
        }
      }
      const text = lines
        .sort((x, y) => x.at - y.at)
        .map((l) => l.text)
        .join('\n');
      await invoke('app:copyText', text);
      toast('success', 'Transcript copied.');
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await invoke('sessions:delete', { id });
      toast('success', 'Session deleted.');
      navigate('sessions');
    } catch (err) {
      toast('error', errorMessage(err));
      setDeleting(false);
    }
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => navigate('sessions')} className="-ml-2">
        <ArrowLeft aria-hidden /> All sessions
      </Button>
      <Card data-testid="session-detail">
        <CardHeader
          title={
            editing ? (
              <Input
                autoFocus
                value={title}
                maxLength={120}
                aria-label="Session title"
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => void rename()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void rename();
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
            ) : (
              <span className="flex items-center gap-2">
                {session.title}
                <StatusBadge status={session.status} />
                <button
                  type="button"
                  onClick={() => {
                    setTitle(session.title);
                    setEditing(true);
                  }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Rename"
                >
                  <Pencil className="size-3.5" />
                </button>
              </span>
            )
          }
          description={[
            when(session.startedAt),
            `${formatClock(session.durationMs)} listened`,
            session.profileName && `Profile: ${session.profileName}`,
            session.knowledgeBaseName && `Knowledge: ${session.knowledgeBaseName}`,
            BACKEND_LABEL[session.audio.backend],
          ]
            .filter(Boolean)
            .join(' · ')}
          action={
            <div className="flex gap-2">
              {session.answers.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAnswers(!showAnswers)}
                  aria-pressed={showAnswers}
                  title="Show the answers the copilot suggested. Copy and Save include what's shown."
                >
                  <Sparkles aria-hidden /> {showAnswers ? 'Hide answers' : 'Show answers'}
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => void copy()}>
                <ClipboardCopy aria-hidden /> Copy
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void save('markdown')}>
                <Download aria-hidden /> Save
              </Button>
              <ConfirmDialog
                title="Delete this session?"
                description="Its transcript is permanently deleted."
                confirmLabel="Delete"
                busy={deleting}
                onConfirm={() => void remove()}
                trigger={
                  <Button size="sm" variant="destructive-outline" aria-label="Delete session">
                    <Trash2 aria-hidden />
                  </Button>
                }
              />
            </div>
          }
        />
        <CardBody>
          {session.status === 'interrupted' && (
            <p className="mb-4 text-[13px] text-warning">
              The app closed unexpectedly during this interview. Everything up to then was saved.
            </p>
          )}
          <TranscriptView
            segments={session.segments}
            answers={withAnswers ? session.answers : []}
            className="max-h-[65vh] text-sm"
            emptyText="Nothing was transcribed in this session."
          />
          {session.cost && <CostNote cost={session.cost} stats={session.stats} />}
          {session.stats && session.stats.echoDropped > 0 && (
            <p className="mt-4 text-xs text-muted-foreground">
              {session.stats.echoDropped} microphone line
              {session.stats.echoDropped === 1 ? '' : 's'} repeated the interviewer (echo) and{' '}
              {session.stats.echoDropped === 1 ? 'was' : 'were'} left out.
            </p>
          )}
        </CardBody>
      </Card>
    </>
  );
}

export function SessionsPage() {
  const sessionId = useApp((s) => s.sessionId);
  const retention = useApp((s) => s.settings?.privacy.transcriptRetention);
  return (
    <Page
      title="Sessions"
      description={`Your interview transcripts. No audio is saved.${
        retention && retention !== 'forever'
          ? ` Transcripts are deleted automatically after ${{ '7d': '7 days', '30d': '30 days', '90d': '90 days', '1y': 'a year' }[retention]} (Settings → Privacy).`
          : ''
      }`}
    >
      {sessionId ? <SessionView id={sessionId} /> : <SessionList />}
    </Page>
  );
}
