import { MessageSquareText, Monitor, Moon, Palette, Sun } from 'lucide-react';
import { Card, CardBody, CardHeader, Field } from '../../components/ui/card';
import { Segmented } from '../../components/ui/segmented';
import { useApp } from '../../store';

export function AnswersCard() {
  const answers = useApp((s) => s.settings?.answers);
  const updateSettings = useApp((s) => s.updateSettings);
  if (!answers) return null;

  return (
    <Card id="answers">
      <CardHeader
        icon={<MessageSquareText />}
        title="Answers"
        description="How the copilot answers during an interview."
      />
      <CardBody>
        <Field
          label="Answer automatically"
          description={
            answers.autoAnswer
              ? 'An answer appears when the interviewer finishes a question.'
              : 'Answers appear only when you press Answer now (or its shortcut).'
          }
        >
          <Segmented
            label="Answer automatically"
            value={answers.autoAnswer ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(v) => void updateSettings({ answers: { autoAnswer: v === 'on' } })}
          />
        </Field>
        <Field
          label="Fact check"
          description="Checks each answer against your profile and notes, and marks anything they don't support."
        >
          <Segmented
            label="Fact check"
            value={answers.factCheck ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(v) => void updateSettings({ answers: { factCheck: v === 'on' } })}
          />
        </Field>
        <Field
          label="Mode"
          description={
            answers.mode === 'fast'
              ? 'First words in about half a second. Best for live interviews.'
              : 'Stronger reasoning, but about 5 seconds before the first words.'
          }
        >
          <Segmented
            label="Answer mode"
            value={answers.mode}
            options={[
              { value: 'fast', label: 'Fast' },
              { value: 'quality', label: 'Quality' },
            ]}
            onChange={(mode) => void updateSettings({ answers: { mode } })}
          />
        </Field>
        <Field
          label="Length"
          description={
            answers.length === 'short'
              ? 'One opening line and two quick points.'
              : answers.length === 'standard'
                ? 'An opening line and up to four short points (about 45 seconds spoken).'
                : 'More detail and an example where it helps.'
          }
        >
          <Segmented
            label="Answer length"
            value={answers.length}
            options={[
              { value: 'short', label: 'Short' },
              { value: 'standard', label: 'Standard' },
              { value: 'detailed', label: 'Detailed' },
            ]}
            onChange={(length) => void updateSettings({ answers: { length } })}
          />
        </Field>
      </CardBody>
    </Card>
  );
}

export function AppearanceCard() {
  const theme = useApp((s) => s.settings?.appearance.theme);
  const updateSettings = useApp((s) => s.updateSettings);
  if (!theme) return null;

  return (
    <Card id="appearance">
      <CardHeader icon={<Palette />} title="Appearance" />
      <CardBody>
        <Field label="Theme" description="System follows your Windows setting.">
          <Segmented
            label="Theme"
            value={theme}
            options={[
              {
                value: 'system',
                label: (
                  <span className="flex items-center gap-1.5">
                    <Monitor className="size-3.5" aria-hidden /> System
                  </span>
                ),
              },
              {
                value: 'light',
                label: (
                  <span className="flex items-center gap-1.5">
                    <Sun className="size-3.5" aria-hidden /> Light
                  </span>
                ),
              },
              {
                value: 'dark',
                label: (
                  <span className="flex items-center gap-1.5">
                    <Moon className="size-3.5" aria-hidden /> Dark
                  </span>
                ),
              },
            ]}
            onChange={(next) => void updateSettings({ appearance: { theme: next } })}
          />
        </Field>
      </CardBody>
    </Card>
  );
}
