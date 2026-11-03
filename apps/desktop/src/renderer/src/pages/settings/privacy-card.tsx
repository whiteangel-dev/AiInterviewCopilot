import type { Settings } from '@aic/ipc';
import { FolderOpen, Lock } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/ui/alert-dialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader, Field } from '../../components/ui/card';
import { Select } from '../../components/ui/select';
import { invoke } from '../../lib/api';
import { errorMessage } from '../../lib/utils';
import { useApp } from '../../store';

type Retention = Settings['privacy']['transcriptRetention'];

const RETENTION: { value: Retention; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' },
  { value: 'forever', label: 'Until I delete them' },
];

export function PrivacyCard() {
  const retention = useApp((s) => s.settings?.privacy.transcriptRetention);
  const updateSettings = useApp((s) => s.updateSettings);
  const toast = useApp((s) => s.toast);
  const [deleting, setDeleting] = useState(false);
  if (!retention) return null;

  const deleteAll = async () => {
    setDeleting(true);
    try {
      await invoke('app:deleteAllData', { confirm: 'DELETE' });
      toast('success', 'All local data was deleted.');
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card id="privacy">
      <CardHeader
        icon={<Lock />}
        title="Privacy and data"
        description="Everything is stored on this computer in an encrypted database."
      />
      <CardBody>
        <Field
          label="Keep interview transcripts"
          description="Older transcripts are deleted automatically."
          htmlFor="retention"
        >
          <Select
            id="retention"
            className="w-48"
            value={retention}
            options={RETENTION}
            onChange={(value) =>
              void updateSettings({ privacy: { transcriptRetention: value as Retention } })
            }
            aria-label="Keep interview transcripts"
          />
        </Field>
        <Field label="Audio recordings" description="Audio is transcribed live and never saved.">
          <Badge tone="success">Never saved</Badge>
        </Field>
        <Field label="Data folder" description="Encrypted database, logs and settings.">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void invoke('app:openPath', 'userData')}
          >
            <FolderOpen aria-hidden /> Open
          </Button>
        </Field>
        <Field
          label="Delete all local data"
          description="Removes your settings, API key and everything else this app stored."
        >
          <ConfirmDialog
            title="Delete all local data?"
            description={
              <>
                <p>
                  This permanently deletes everything this app stored on this computer, including
                  your API key.
                </p>
                <p>It can't be undone.</p>
              </>
            }
            confirmLabel="Delete everything"
            busy={deleting}
            onConfirm={() => void deleteAll()}
            trigger={
              <Button variant="destructive-outline" size="sm">
                Delete…
              </Button>
            }
          />
        </Field>
      </CardBody>
    </Card>
  );
}
