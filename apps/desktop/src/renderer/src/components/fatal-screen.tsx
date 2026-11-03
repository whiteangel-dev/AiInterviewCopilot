import type { SerializedError } from '@aic/ipc';
import { FolderOpen, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { invoke } from '../lib/api';
import { errorMessage } from '../lib/utils';
import { useApp } from '../store';
import { ConfirmDialog } from './ui/alert-dialog';
import { Button } from './ui/button';
import { Card } from './ui/card';

const TITLES: Partial<Record<SerializedError['code'], string>> = {
  db_unlock_failed: "Your local data can't be opened",
  db_newer_than_app: 'Please update the app',
  secure_storage_unavailable: "Secure storage isn't available",
  engine_unavailable: 'The background engine stopped',
};

export function FatalScreen({ error }: { error: SerializedError }) {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const canReset = error.code === 'db_unlock_failed' || error.code === 'secure_storage_unavailable';

  const reset = async () => {
    setBusy(true);
    try {
      await invoke('app:deleteAllData', { confirm: 'DELETE' });
      toast('success', 'Local data deleted. You can set up the app again.');
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-10">
      <Card className="max-w-lg p-8" role="alert">
        <div className="flex size-10 items-center justify-center rounded-full bg-destructive/12 text-destructive">
          <TriangleAlert className="size-5" aria-hidden />
        </div>
        <h1 className="mt-4 font-display text-xl font-semibold">
          {TITLES[error.code] ?? 'Something went wrong'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-6 flex flex-wrap gap-2">
          {canReset && (
            <ConfirmDialog
              title="Delete local data and start fresh?"
              description={
                <p>
                  Your saved settings and API key on this computer will be deleted. This can't be
                  undone.
                </p>
              }
              confirmLabel="Delete and start fresh"
              busy={busy}
              onConfirm={() => void reset()}
              trigger={<Button variant="destructive">Start fresh</Button>}
            />
          )}
          <Button variant="secondary" onClick={() => void invoke('app:openPath', 'logs')}>
            <FolderOpen aria-hidden /> Open logs folder
          </Button>
        </div>
      </Card>
    </div>
  );
}
