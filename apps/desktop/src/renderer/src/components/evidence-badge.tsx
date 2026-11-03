import type { EvidenceStatus } from '@aic/ipc';
import { CircleCheck, CircleHelp, Lightbulb, PencilLine, TriangleAlert } from 'lucide-react';
import { Badge } from './ui/badge';

const LABELS: Record<
  EvidenceStatus,
  { label: string; tone: 'success' | 'warning' | 'neutral' | 'accent'; icon: typeof CircleCheck }
> = {
  verified: { label: 'From resume', tone: 'success', icon: CircleCheck },
  unverified: { label: 'Not found in resume', tone: 'warning', icon: TriangleAlert },
  unchecked: { label: 'Not checked', tone: 'neutral', icon: CircleHelp },
  inferred: { label: 'Interpretation', tone: 'accent', icon: Lightbulb },
  user: { label: 'Edited', tone: 'neutral', icon: PencilLine },
};

/** Where a profile statement comes from; hover shows the supporting quote. */
export function EvidenceBadge({
  status,
  quote,
}: {
  status: EvidenceStatus;
  quote?: string | null;
}) {
  const { label, tone, icon: Icon } = LABELS[status];
  const title =
    status === 'unverified'
      ? `This wasn't found in your resume${quote ? `: “${quote}”` : ''}. Check that it's accurate, then edit or delete it.`
      : status === 'verified' && quote
        ? `Resume: “${quote}”`
        : status === 'unchecked'
          ? "Your resume has no text layer (it may be scanned), so this couldn't be checked automatically."
          : status === 'inferred'
            ? 'An interpretation of your resume, not a statement from it.'
            : 'You wrote or edited this.';
  return (
    <Badge tone={tone} title={title} data-status={status} className="shrink-0">
      <Icon aria-hidden /> {label}
    </Badge>
  );
}
