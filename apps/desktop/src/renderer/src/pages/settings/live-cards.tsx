import { DEFAULT_SETTINGS, type HotkeyAction, type HotkeyStatus, type Settings } from '@aic/ipc';
import { acceleratorFromKey, formatAccelerator } from '@aic/ipc/hotkeys';
import { AudioLines, Keyboard, PanelRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader, Field } from '../../components/ui/card';
import { Segmented } from '../../components/ui/segmented';
import { invoke, on } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useApp } from '../../store';

const onOff = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const;

export function AudioLinkCard() {
  const navigate = useApp((s) => s.navigate);
  return (
    <Card id="audio">
      <CardHeader
        icon={<AudioLines />}
        title="Audio"
        description="Microphone, interviewer audio and an audio test."
        action={
          <Button size="sm" variant="secondary" onClick={() => navigate('audio')}>
            Open
          </Button>
        }
      />
    </Card>
  );
}

export function CopilotCard() {
  const copilot = useApp((s) => s.settings?.copilot);
  const updateSettings = useApp((s) => s.updateSettings);
  if (!copilot) return null;
  const set = (patch: Partial<Settings['copilot']>) => void updateSettings({ copilot: patch });

  return (
    <Card id="copilot">
      <CardHeader
        icon={<PanelRight />}
        title="Copilot window"
        description="The small window with the live transcript during an interview."
      />
      <CardBody>
        <Field label="Show when an interview starts">
          <Segmented
            label="Show when an interview starts"
            value={copilot.showOnStart ? 'on' : 'off'}
            options={onOff}
            onChange={(v) => set({ showOnStart: v === 'on' })}
          />
        </Field>
        <Field label="Always on top" description="Stays above the call window.">
          <Segmented
            label="Always on top"
            value={copilot.alwaysOnTop ? 'on' : 'off'}
            options={onOff}
            onChange={(v) => set({ alwaysOnTop: v === 'on' })}
          />
        </Field>
        <Field
          label="Hide from screen sharing"
          description="Keeps your notes private when you share your screen or record (Windows 10 2004 or later)."
        >
          <Segmented
            label="Hide from screen sharing"
            value={copilot.hideFromScreenShare ? 'on' : 'off'}
            options={onOff}
            onChange={(v) => set({ hideFromScreenShare: v === 'on' })}
          />
        </Field>
        <Field label="Opacity">
          <Segmented
            label="Opacity"
            value={String(copilot.opacity)}
            options={[
              { value: '1', label: '100%' },
              { value: '0.96', label: '96%' },
              { value: '0.85', label: '85%' },
              { value: '0.7', label: '70%' },
            ]}
            onChange={(v) => set({ opacity: Number(v) })}
          />
        </Field>
        <Field label="Text size">
          <Segmented
            label="Text size"
            value={copilot.fontSize}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large', label: 'Large' },
            ]}
            onChange={(fontSize) => set({ fontSize })}
          />
        </Field>
      </CardBody>
    </Card>
  );
}

const ACTIONS: { action: HotkeyAction; label: string; description: string }[] = [
  {
    action: 'toggleCopilot',
    label: 'Show or hide the copilot',
    description: 'Works while another app has focus.',
  },
  {
    action: 'pauseListening',
    label: 'Pause or resume listening',
    description: 'During an interview.',
  },
  {
    action: 'answerNow',
    label: 'Answer now',
    description: 'Answers what the interviewer just said, without waiting.',
  },
  {
    action: 'regenerate',
    label: 'Regenerate the answer',
    description: 'Writes a new answer to the last question.',
  },
];

function HotkeyRecorder({
  value,
  status,
  onChange,
}: {
  value: string | null;
  status: HotkeyStatus | undefined;
  onChange: (value: string | null) => void;
}) {
  const platform = useApp((s) => s.info?.platform ?? 'win32');
  const [recording, setRecording] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          if (e.key === 'Escape') {
            setRecording(false);
            return;
          }
          const accel = acceleratorFromKey(e, platform);
          if (accel) {
            setRecording(false);
            onChange(accel);
          }
        }}
        className={cn(
          'h-8 min-w-40 rounded-md border px-3 font-mono text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
          recording
            ? 'border-primary bg-accent text-accent-foreground'
            : 'border-input bg-background',
        )}
        aria-label={
          value
            ? `Shortcut ${formatAccelerator(value, platform)}. Press to change.`
            : 'Set a shortcut'
        }
      >
        {recording ? 'Press keys…' : value ? formatAccelerator(value, platform) : 'Not set'}
      </button>
      {value && status && !status.registered && (
        <Badge tone="warning" title="Another app already uses this shortcut.">
          In use
        </Badge>
      )}
      {value && (
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          Clear
        </Button>
      )}
    </div>
  );
}

export function HotkeysCard() {
  const hotkeys = useApp((s) => s.settings?.hotkeys);
  const updateSettings = useApp((s) => s.updateSettings);
  const [statuses, setStatuses] = useState<HotkeyStatus[]>([]);

  useEffect(() => {
    void invoke('hotkeys:status')
      .then(setStatuses)
      .catch(() => undefined);
    return on('hotkeys:status', setStatuses);
  }, []);

  if (!hotkeys) return null;
  const isDefault = ACTIONS.every(
    ({ action }) => hotkeys[action] === DEFAULT_SETTINGS.hotkeys[action],
  );

  return (
    <Card id="hotkeys">
      <CardHeader
        icon={<Keyboard />}
        title="Keyboard shortcuts"
        description="Click a shortcut, then press the keys you want. Use Ctrl or Alt with another key. Avoid Ctrl+Alt with a letter if your keyboard uses AltGr for symbols."
        action={
          !isDefault && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void updateSettings({ hotkeys: DEFAULT_SETTINGS.hotkeys })}
            >
              Reset
            </Button>
          )
        }
      />
      <CardBody>
        {ACTIONS.map(({ action, label, description }) => (
          <Field key={action} label={label} description={description}>
            <HotkeyRecorder
              value={hotkeys[action]}
              status={statuses.find((s) => s.action === action)}
              onChange={(value) => void updateSettings({ hotkeys: { [action]: value } })}
            />
          </Field>
        ))}
      </CardBody>
    </Card>
  );
}
