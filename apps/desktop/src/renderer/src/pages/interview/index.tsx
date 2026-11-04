import type { LiveState } from '@aic/ipc';
import {
  ArrowRight,
  Eye,
  EyeOff,
  History,
  Pause,
  Play,
  Radio,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { LevelMeter } from '../../components/live/level-meter';
import { SuggestionCard } from '../../components/live/suggestion-card';
import { TranscriptView } from '../../components/live/transcript-view';
import { LiveWarnings } from '../../components/live/warnings';
import { Page } from '../../components/page';
import { ConfirmDialog } from '../../components/ui/alert-dialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader, Field } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Select } from '../../components/ui/select';
import { formatClock, isActive, useElapsed, useLive } from '../../live-store';
import { errorMessage } from '../../lib/utils';
import { useApp } from '../../store';
import { BACKEND_LABEL } from '../../lib/labels';

const NONE = '__none__';

function SetupCard() {
  const profiles = useApp((s) => s.profiles) ?? [];
  const bases = useApp((s) => s.bases) ?? [];
  const apiKey = useApp((s) => s.apiKey);
  const settings = useApp((s) => s.settings);
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const start = useLive((s) => s.start);
  const testRunning = useLive((s) => s.state?.mode === 'test' && isActive(s.state));
  const [title, setTitle] = useState('');
  const [profileChoice, setProfileId] = useState<string | null>(null);
  const [baseChoice, setBaseId] = useState<string | null>(null);
  // Until the user picks, default to the first profile and knowledge base (they may load later).
  const profileId = profileChoice ?? profiles[0]?.id ?? NONE;
  const baseId = baseChoice ?? bases[0]?.id ?? NONE;
  const [busy, setBusy] = useState(false);
  const hasKey = !!apiKey?.configured;
  const audio = settings?.audio;

  const begin = async () => {
    setBusy(true);
    try {
      await start({
        mode: 'interview',
        title: title.trim(),
        profileId: profileId === NONE ? null : profileId,
        knowledgeBaseId: baseId === NONE ? null : baseId,
        transcribe: true,
      });
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={<Radio />}
        title="New interview"
        description="The copilot transcribes both sides and shows matching answers from your answer bank."
      />
      <CardBody>
        <Field label="Title" description="For your session history, e.g. the company and round.">
          <Input
            className="w-64"
            value={title}
            maxLength={120}
            placeholder="Acme, backend engineer, round 2"
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Interview title"
          />
        </Field>
        <Field label="Profile" description="Your resume profile for this application.">
          <Select
            aria-label="Profile"
            value={profileId}
            options={[
              ...profiles.map((p) => ({ value: p.id, label: p.name })),
              { value: NONE, label: 'No profile' },
            ]}
            onChange={setProfileId}
          />
        </Field>
        <Field label="Knowledge" description="Notes about this company and role.">
          <Select
            aria-label="Knowledge base"
            value={baseId}
            options={[
              ...bases.map((b) => ({ value: b.id, label: b.name })),
              { value: NONE, label: 'None' },
            ]}
            onChange={setBaseId}
          />
        </Field>
        <Field
          label="Audio"
          description={
            audio
              ? `${audio.interviewerSource === 'app' && audio.appName ? `Interviewer: ${audio.appName}` : 'Interviewer: all system audio'} · Microphone: ${audio.microphoneId ? 'chosen device' : 'default'}`
              : ''
          }
        >
          <Button size="sm" variant="secondary" onClick={() => navigate('audio')}>
            Check audio
          </Button>
        </Field>

        {!hasKey && (
          <p className="mt-4 flex items-center gap-2 text-sm text-warning">
            <TriangleAlert className="size-4" aria-hidden /> Add your Gemini API key in Settings
            first.
          </p>
        )}
        {testRunning && (
          <p className="mt-4 text-sm text-muted-foreground">
            An audio test is running. Stop it first.
          </p>
        )}

        <div className="mt-5 flex items-center justify-between gap-4 border-t border-border pt-5">
          <p className="text-[13px] text-muted-foreground">
            Make sure everyone on the call agrees to transcription, and that your employer's rules
            allow it.
          </p>
          {hasKey ? (
            <Button
              onClick={() => void begin()}
              loading={busy}
              disabled={testRunning}
              data-testid="start-interview"
            >
              <Radio aria-hidden /> Start listening
            </Button>
          ) : (
            <Button onClick={() => navigate('settings', { section: 'api-key' })}>
              Add API key <ArrowRight aria-hidden />
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function EndedBanner({ state }: { state: LiveState }) {
  const navigate = useApp((s) => s.navigate);
  return (
    <Card data-testid="interview-ended">
      <CardBody className="flex items-center gap-4 pt-5">
        <History className="size-5 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Interview saved: {state.title}</div>
          <div className="text-[13px] text-muted-foreground">
            {formatClock(state.elapsedMs)} listened. The transcript is in Sessions.
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => navigate('sessions', { sessionId: state.id })}
        >
          Open transcript
        </Button>
      </CardBody>
    </Card>
  );
}

function LiveView({ state }: { state: LiveState }) {
  const {
    meter,
    segments,
    interim,
    suggestion,
    pause,
    resume,
    stop,
    copilotVisible,
    setCopilotVisible,
  } = useLive();
  const toast = useApp((s) => s.toast);
  const elapsed = useElapsed(state);
  const [stopping, setStopping] = useState(false);
  const act = (fn: () => Promise<void>) => () =>
    void fn().catch((err: unknown) => toast('error', errorMessage(err)));
  const live = state.status === 'live';

  return (
    <Card data-testid="interview-live" data-status={state.status}>
      <CardHeader
        icon={<Radio />}
        title={
          <span className="flex items-center gap-2">
            {state.title}
            <Badge tone={live ? 'danger' : 'warning'}>{live ? 'Listening' : 'Paused'}</Badge>
          </span>
        }
        description={
          <span className="font-mono tabular-nums">
            {formatClock(elapsed)} · {BACKEND_LABEL[state.backend]}
          </span>
        }
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={act(() => setCopilotVisible(!copilotVisible))}
            >
              {copilotVisible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              {copilotVisible ? 'Hide copilot' : 'Show copilot'}
            </Button>
            {live ? (
              <Button size="sm" variant="secondary" onClick={act(pause)}>
                <Pause aria-hidden /> Pause
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={act(resume)}>
                <Play aria-hidden /> Resume
              </Button>
            )}
            <ConfirmDialog
              title="End this interview?"
              description="The copilot stops listening. The transcript is saved in Sessions."
              confirmLabel="End interview"
              busy={stopping}
              onConfirm={() => {
                setStopping(true);
                void stop()
                  .catch((err: unknown) => toast('error', errorMessage(err)))
                  .finally(() => setStopping(false));
              }}
              trigger={
                <Button size="sm" variant="destructive-outline" data-testid="end-interview">
                  <Square aria-hidden /> End
                </Button>
              }
            />
          </div>
        }
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-6">
          <LevelMeter
            label="Interviewer"
            db={live ? meter?.levels.interviewer.db : undefined}
            speaking={live && meter?.levels.interviewer.speaking}
            status={state.channels.interviewer}
          />
          <LevelMeter
            label="You"
            db={live ? meter?.levels.candidate.db : undefined}
            speaking={live && meter?.levels.candidate.speaking}
            status={state.channels.candidate}
          />
        </div>
        <LiveWarnings warnings={state.warnings} />
        {suggestion && <SuggestionCard suggestion={suggestion} />}
        <TranscriptView
          segments={segments}
          interim={interim}
          className="h-[min(50vh,520px)] rounded-lg border border-border p-4 text-sm"
          emptyText={live ? 'Listening… The transcript appears as people talk.' : 'Paused.'}
        />
      </CardBody>
    </Card>
  );
}

export function InterviewPage() {
  const state = useLive((s) => s.state);
  const interview = state?.mode === 'interview' ? state : null;
  const active = isActive(interview);
  return (
    <Page
      title="Interview"
      description="A live transcript of both sides, with matching answers from your answer bank."
    >
      {active && interview ? (
        <LiveView state={interview} />
      ) : (
        <>
          {interview?.status === 'ended' && <EndedBanner state={interview} />}
          <SetupCard />
        </>
      )}
    </Page>
  );
}
