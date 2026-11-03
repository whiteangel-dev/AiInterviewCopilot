import {
  ArrowRight,
  AudioLines,
  CircleCheck,
  FileText,
  KeyRound,
  Lock,
  MessageSquareText,
  NotebookPen,
  Radio,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Page } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardBody, CardHeader } from '../components/ui/card';
import { cn } from '../lib/utils';
import { useApp } from '../store';

interface Step {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  done: boolean;
  action?: ReactNode;
  upcoming?: boolean;
}

export function HomePage() {
  const apiKey = useApp((s) => s.apiKey);
  const navigate = useApp((s) => s.navigate);
  const connected = !!apiKey?.configured && apiKey.verification !== 'invalid';

  const steps: Step[] = [
    {
      icon: KeyRound,
      title: 'Connect Gemini',
      description: connected
        ? `Connected with the key ending in ${apiKey?.hint ?? '····'}.`
        : 'Add your Google Gemini API key. It powers transcription and answers.',
      done: connected,
      action: !connected && (
        <Button size="sm" onClick={() => navigate('settings', 'api-key')}>
          {apiKey?.configured ? 'Fix API key' : 'Add API key'} <ArrowRight aria-hidden />
        </Button>
      ),
    },
    {
      icon: FileText,
      title: 'Import your resume',
      description: 'Upload a PDF or Word file and review what was extracted.',
      done: false,
      upcoming: true,
    },
    {
      icon: NotebookPen,
      title: 'Add application knowledge',
      description: 'Notes, facts and instructions the answers should follow.',
      done: false,
      upcoming: true,
    },
    {
      icon: Radio,
      title: 'Start an interview session',
      description: 'Pick the company and role, then let the copilot listen.',
      done: false,
      upcoming: true,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <Page
      title="Welcome"
      description="Real-time answer suggestions during your interviews, grounded in your own experience."
    >
      <Card data-testid="setup-steps">
        <CardHeader
          title="Get ready"
          description="A few steps before your first session."
          action={
            <Badge tone={doneCount === steps.length ? 'success' : 'neutral'}>
              {doneCount} of {steps.length} done
            </Badge>
          }
        />
        <CardBody className="pb-2">
          <ol>
            {steps.map((step) => (
              <li
                key={step.title}
                className="flex items-center gap-4 border-t border-border py-4 first:border-t-0 first:pt-1"
              >
                <div
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-full',
                    step.done ? 'bg-success/12 text-success' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {step.done ? (
                    <CircleCheck className="size-[18px]" aria-label="Done" />
                  ) : (
                    <step.icon className="size-[18px]" aria-hidden />
                  )}
                </div>
                <div className={cn('min-w-0 flex-1', step.upcoming && 'opacity-60')}>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {step.title}
                    {step.upcoming && <Badge>Coming soon</Badge>}
                  </div>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">{step.description}</p>
                </div>
                {step.action}
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="How it works" />
        <CardBody className="grid grid-cols-3 gap-5">
          <Feature icon={AudioLines} title="Listens to the call">
            The interviewer comes from your speakers and you from your microphone, so the two are
            never mixed up.
          </Feature>
          <Feature icon={MessageSquareText} title="Spots each question">
            It waits for the interviewer to finish, even when they pause mid-sentence.
          </Feature>
          <Feature icon={Sparkles} title="Suggests what to say">
            An opening line and a few short points, in about a second, based only on your real
            experience.
          </Feature>
        </CardBody>
      </Card>

      <PrivacyNote />
    </Page>
  );
}

function Feature({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
        <Icon className="size-4" aria-hidden />
      </div>
      <h3 className="mt-3 text-sm font-medium">{title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

function PrivacyNote() {
  const info = useApp((s) => s.info);
  const keyProtection =
    info?.secureStorage === 'os'
      ? info.platform === 'darwin'
        ? 'protected by the macOS Keychain'
        : 'protected by Windows credential encryption'
      : 'stored with basic protection on this system';
  return (
    <div className="flex gap-3 rounded-xl border border-dashed border-border px-5 py-4 text-[13px] text-muted-foreground">
      <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        Your data stays on this computer in an encrypted database. Your API key is {keyProtection}{' '}
        and is only sent to Google. Raw audio is never saved.
      </p>
    </div>
  );
}
