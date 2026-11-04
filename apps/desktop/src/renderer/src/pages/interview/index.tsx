import type { LiveState } from '@aic/ipc';
import { formatAccelerator } from '@aic/ipc/hotkeys';
import {
  ArrowRight,
  Eye,
  EyeOff,
  History,
  Pause,
  Play,
  Radio,
  Smartphone,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { PhoneQr } from '../../components/phone-qr';
import { usePhone } from '../../lib/use-phone';
import { Dialog } from '../../components/ui/dialog';
import { useState } from 'react';
import { AnswerCard } from '../../components/live/answer-card';
import { LevelMeter } from '../../components/live/level-meter';
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
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
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
        company: company.trim(),
        role: role.trim(),
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
        description="The copilot transcribes both sides, notices when the interviewer asks a question, and suggests an answer from your own experience."
      />
      <CardBody>
        <Field
          label="Company"
          description="Helps with questions like “Why do you want to work here?”"
        >
          <Input
            className="w-64"
            value={company}
            maxLength={120}
            placeholder="Acme"
            onChange={(e) => setCompany(e.target.value)}
            aria-label="Company"
          />
        </Field>
        <Field label="Role">
          <Input
            className="w-64"
            value={role}
            maxLength={120}
            placeholder="Senior Backend Engineer"
            onChange={(e) => setRole(e.target.value)}
            aria-label="Role"
          />
        </Field>
        <Field
          label="Title"
          description="For your session history. Leave empty to use the company and role."
        >
          <Input
            className="w-64"
            value={title}
            maxLength={120}
            placeholder="Acme, round 2"
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
    answers,
    phase,
    pause,
    resume,
    stop,
    answerNow,
    regenerate,
    copilotVisible,
    setCopilotVisible,
  } = useLive();
  const toast = useApp((s) => s.toast);
  const answerKey = useApp((s) => s.settings?.hotkeys.answerNow);
  const platform = useApp((s) => s.info?.platform ?? 'win32');
  const elapsed = useElapsed(state);
  const [stopping, setStopping] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const phone = usePhone();
  const updateSettings = useApp((s) => s.updateSettings);
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
              onClick={() => setPhoneOpen(true)}
              data-testid="open-phone"
            >
              <Smartphone aria-hidden /> Phone
              {!!phone?.clients && <Badge tone="success">{phone.clients}</Badge>}
            </Button>
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
      <Dialog
        open={phoneOpen}
        onOpenChange={setPhoneOpen}
        title="Answers on your phone"
        description="Open this interview's answers on a phone on the same Wi-Fi."
      >
        {phone?.running ? (
          <PhoneQr status={phone} />
        ) : (
          <div className="space-y-3 text-[13px] text-muted-foreground">
            <p>{phone?.error ?? 'The phone screen is off.'}</p>
            <Button size="sm" onClick={() => void updateSettings({ phone: { enabled: true } })}>
              Turn on the phone screen
            </Button>
          </div>
        )}
      </Dialog>
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
        <AnswerCard
          answers={answers}
          phase={phase}
          live={live}
          answerNowHint={answerKey ? formatAccelerator(answerKey, platform) : null}
          onAnswerNow={act(answerNow)}
          onRegenerate={(id, length) => act(() => regenerate(id, length))()}
          className="h-[min(40vh,360px)] text-sm"
        />
        <TranscriptView
          segments={segments}
          interim={interim}
          className="h-[min(40vh,420px)] rounded-lg border border-border p-4 text-sm"
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
      description="A live transcript of both sides, and an answer whenever the interviewer asks a question."
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
