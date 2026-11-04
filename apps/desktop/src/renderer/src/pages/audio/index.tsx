import type { AudioEnvironment } from '@aic/ipc';
import {
  AudioLines,
  ClipboardCopy,
  Headphones,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { LevelMeter } from '../../components/live/level-meter';
import { TranscriptView } from '../../components/live/transcript-view';
import { LiveWarnings } from '../../components/live/warnings';
import { Page } from '../../components/page';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader, Field } from '../../components/ui/card';
import { Segmented } from '../../components/ui/segmented';
import { Select } from '../../components/ui/select';
import { isActive, useLive } from '../../live-store';
import { invoke } from '../../lib/api';
import { BACKEND_LABEL } from '../../lib/labels';
import { errorMessage } from '../../lib/utils';
import { useApp } from '../../store';

const DEFAULT = '__default__';

function useEnvironment() {
  const [env, setEnv] = useState<AudioEnvironment | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useApp((s) => s.toast);
  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      try {
        setEnv(await invoke('audio:environment', { refresh }));
      } catch (err) {
        toast('error', `Couldn't list audio devices: ${errorMessage(err)}`);
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );
  useEffect(() => {
    invoke('audio:environment', { refresh: false })
      .then(setEnv)
      .catch((err: unknown) => toast('error', `Couldn't list audio devices: ${errorMessage(err)}`));
  }, [toast]);
  return { env, loading, reload: () => load(true) };
}

function CaptureCard({
  env,
  loading,
  reload,
}: {
  env: AudioEnvironment | null;
  loading: boolean;
  reload: () => Promise<void>;
}) {
  const audio = useApp((s) => s.settings?.audio);
  const updateSettings = useApp((s) => s.updateSettings);
  if (!audio) return null;
  const native = env?.backend === 'native';
  const inputs = env?.devices.filter((d) => d.kind === 'input') ?? [];
  const outputs = env?.devices.filter((d) => d.kind === 'output') ?? [];
  const apps = env?.apps ?? [];
  const appKnown = !audio.appName || apps.some((a) => a.name === audio.appName);

  return (
    <Card id="capture">
      <CardHeader
        icon={<AudioLines />}
        title="What the copilot listens to"
        description="The interviewer is your computer's audio; you are the microphone."
        action={
          <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden /> Refresh
          </Button>
        }
      />
      <CardBody>
        <Field
          label="Capture method"
          description={
            env
              ? `In use: ${BACKEND_LABEL[env.backend]}.${
                  env.native.available
                    ? ''
                    : env.platform === 'win32'
                      ? ` Native capture isn't available (${env.native.error ?? 'unknown error'}).`
                      : ' Native capture is Windows-only for now.'
                }`
              : 'Checking…'
          }
        >
          <Segmented
            label="Capture method"
            value={audio.backend}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'native', label: 'Native' },
              { value: 'browser', label: 'Built-in' },
            ]}
            onChange={(backend) => void updateSettings({ audio: { backend } }).then(() => reload())}
          />
        </Field>

        <Field
          label="Microphone"
          description={native ? 'Your voice.' : 'Built-in capture uses your default microphone.'}
        >
          <Select
            aria-label="Microphone"
            value={audio.microphoneId ?? DEFAULT}
            disabled={!native}
            options={[
              { value: DEFAULT, label: 'System default' },
              ...inputs.map((d) => ({
                value: d.id,
                label: d.name,
                hint: d.isDefault ? 'default' : undefined,
              })),
            ]}
            onChange={(v) =>
              void updateSettings({ audio: { microphoneId: v === DEFAULT ? null : v } })
            }
          />
        </Field>

        <Field
          label="Interviewer audio"
          description={
            audio.interviewerSource === 'app'
              ? 'Only the call app. Notifications and other sounds are ignored (Windows 10 2004 or later).'
              : 'Everything your computer plays.'
          }
        >
          <Segmented
            label="Interviewer audio"
            value={native ? audio.interviewerSource : 'system'}
            options={[
              { value: 'system', label: 'All system audio' },
              ...(native ? [{ value: 'app' as const, label: 'One app' }] : []),
            ]}
            onChange={(interviewerSource) => void updateSettings({ audio: { interviewerSource } })}
          />
        </Field>

        {native && audio.interviewerSource === 'system' && (
          <Field label="Speakers or headphones" description="The output your call plays through.">
            <Select
              aria-label="Output device"
              value={audio.outputDeviceId ?? DEFAULT}
              options={[
                { value: DEFAULT, label: 'Default output' },
                ...outputs.map((d) => ({
                  value: d.id,
                  label: d.name,
                  hint: d.isDefault ? 'default' : undefined,
                })),
              ]}
              onChange={(v) =>
                void updateSettings({ audio: { outputDeviceId: v === DEFAULT ? null : v } })
              }
            />
          </Field>
        )}

        {native && audio.interviewerSource === 'app' && (
          <Field
            label="Call app"
            description={
              apps.length === 0
                ? 'No apps are playing audio. Join your call (or play a test sound), then press Refresh.'
                : 'Apps with audio right now. ▶ means playing.'
            }
          >
            <Select
              aria-label="Call app"
              value={audio.appName ?? undefined}
              placeholder="Choose an app"
              options={[
                ...apps.map((a) => ({
                  value: a.name,
                  label: `${a.active ? '▶ ' : ''}${a.displayName}`,
                  hint: a.name,
                })),
                ...(!appKnown && audio.appName
                  ? [{ value: audio.appName, label: audio.appName, hint: 'not running' }]
                  : []),
              ]}
              onChange={(appName) => void updateSettings({ audio: { appName } })}
            />
          </Field>
        )}

        <Field
          label="Transcribe my microphone"
          description="Keeps what you said, so later answers stay consistent with it."
        >
          <Segmented
            label="Transcribe my microphone"
            value={audio.transcribeMicrophone ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(v) => void updateSettings({ audio: { transcribeMicrophone: v === 'on' } })}
          />
        </Field>
      </CardBody>
    </Card>
  );
}

function TestCard() {
  const { state, meter, segments, interim, start, stop } = useLive();
  const apiKey = useApp((s) => s.apiKey);
  const toast = useApp((s) => s.toast);
  const [transcribe, setTranscribe] = useState(true);
  const [busy, setBusy] = useState(false);
  const test = state?.mode === 'test' ? state : null;
  const running = isActive(test);
  const interviewRunning = state?.mode === 'interview' && isActive(state);
  const canTranscribe = !!apiKey?.configured;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const copyDiagnostics = () =>
    run(async () => {
      await invoke('app:copyText', await invoke('live:diagnostics'));
      toast('success', 'Diagnostics copied. They contain no audio or transcript text.');
    });

  return (
    <Card id="test">
      <CardHeader
        icon={<Mic />}
        title="Test your audio"
        description="Talk, and play a video or a test call. Both meters should move, each only for its own side."
        action={
          running ? (
            <Button size="sm" variant="secondary" onClick={() => void run(stop)} disabled={busy}>
              <Square aria-hidden /> Stop test
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() =>
                void run(() =>
                  start({
                    mode: 'test',
                    title: '',
                    profileId: null,
                    knowledgeBaseId: null,
                    transcribe: transcribe && canTranscribe,
                  }),
                )
              }
              disabled={busy || interviewRunning}
              data-testid="start-audio-test"
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />} Start
              test
            </Button>
          )
        }
      />
      <CardBody className="space-y-5">
        {interviewRunning && (
          <p className="text-sm text-muted-foreground">
            An interview is in progress. End it to run a test.
          </p>
        )}
        {!running && (
          <Field
            label="Transcribe during the test"
            description={
              canTranscribe
                ? 'Checks that speech is recognized (uses a little of your Gemini quota).'
                : 'Add your Gemini API key in Settings to test transcription.'
            }
          >
            <Segmented
              label="Transcribe during the test"
              value={transcribe && canTranscribe ? 'on' : 'off'}
              options={[
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Levels only' },
              ]}
              onChange={(v) => setTranscribe(v === 'on')}
            />
          </Field>
        )}
        {test && (
          <div className="space-y-4" data-testid="audio-test" data-status={test.status}>
            <div className="flex items-center gap-2 text-sm">
              <Badge tone={running ? 'success' : 'neutral'}>
                {running ? 'Testing' : 'Stopped'}
              </Badge>
              <span className="text-muted-foreground">{BACKEND_LABEL[test.backend]}</span>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <LevelMeter
                label="Interviewer"
                db={running ? meter?.levels.interviewer.db : undefined}
                speaking={running && meter?.levels.interviewer.speaking}
                status={test.channels.interviewer}
              />
              <LevelMeter
                label="You"
                db={running ? meter?.levels.candidate.db : undefined}
                speaking={running && meter?.levels.candidate.speaking}
                status={test.channels.candidate}
              />
            </div>
            <LiveWarnings warnings={test.warnings} />
            {test.transcribing && (
              <TranscriptView
                segments={segments}
                interim={interim}
                className="max-h-64 rounded-lg border border-border p-3 text-sm"
                emptyText="Say something, like “Testing, one, two, three.”"
              />
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
          <p className="text-[13px] text-muted-foreground">
            Something not working? Copy a report of your devices and the last test, and send it to
            support.
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void copyDiagnostics()}
            disabled={busy}
          >
            <ClipboardCopy aria-hidden /> Copy diagnostics
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function TipsCard() {
  return (
    <Card>
      <CardHeader icon={<Headphones />} title="For the best results" />
      <CardBody>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            <span className="text-foreground">Use headphones.</span> With speakers, your microphone
            also hears the interviewer and the two voices get mixed up.
          </li>
          <li>
            If your microphone stays silent on Windows, open Settings → Privacy &amp; security →
            Microphone and turn on “Let desktop apps access your microphone”.
          </li>
          <li>
            Choose <span className="text-foreground">One app</span> to ignore notifications and
            music. Join the call first so the app appears in the list.
          </li>
          <li>No audio is ever saved. Only the text transcript of interviews is kept.</li>
        </ul>
      </CardBody>
    </Card>
  );
}

export function AudioPage() {
  const { env, loading, reload } = useEnvironment();
  return (
    <Page
      title="Audio"
      description="Choose what the copilot listens to and check that it hears both sides."
    >
      <CaptureCard env={env} loading={loading} reload={reload} />
      <TestCard />
      <TipsCard />
    </Page>
  );
}
