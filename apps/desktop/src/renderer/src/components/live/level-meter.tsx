import type { ChannelStatus } from '@aic/ipc';
import { cn } from '../../lib/utils';

const FLOOR_DB = -60;

/** 0–100 for a level in dBFS (−60 dB and below shows as empty). */
function meterPercent(db: number): number {
  return Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100));
}

const CAPTURE_LABEL: Record<ChannelStatus['capture'], string> = {
  off: 'Off',
  starting: 'Starting…',
  ok: 'Capturing',
  recovering: 'Reconnecting…',
  error: 'Not working',
};

const STT_LABEL: Record<ChannelStatus['stt'], string> = {
  off: '',
  connecting: 'Connecting…',
  connected: 'Transcribing',
  reconnecting: 'Reconnecting…',
  error: 'Transcription stopped',
};

export function LevelMeter({
  label,
  db,
  speaking,
  status,
  compact = false,
}: {
  label: string;
  db: number | undefined;
  speaking: boolean | undefined;
  status?: ChannelStatus;
  compact?: boolean;
}) {
  const percent = meterPercent(db ?? -100);
  const bad = status?.capture === 'error' || status?.stt === 'error';
  return (
    <div className="min-w-0" data-testid={`meter-${label.toLowerCase()}`} data-db={db ?? -100}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              speaking ? 'bg-success' : 'bg-muted-foreground/40',
            )}
            aria-hidden
          />
          <span className="truncate">{label}</span>
        </span>
        {!compact && status && (
          <span className={cn('truncate', bad ? 'text-destructive' : 'text-muted-foreground')}>
            {[CAPTURE_LABEL[status.capture], STT_LABEL[status.stt]].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
      <div
        className={cn('mt-1 overflow-hidden rounded-full bg-muted', compact ? 'h-1' : 'h-1.5')}
        role="meter"
        aria-label={`${label} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-100',
            percent > 92 ? 'bg-warning' : 'bg-primary',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {!compact && status?.source && (
        <div className="mt-1 truncate text-[11px] text-muted-foreground">{status.source}</div>
      )}
      {!compact && status?.error && (
        <div className="mt-1 text-[11px] text-destructive" role="alert">
          {status.error}
        </div>
      )}
    </div>
  );
}
