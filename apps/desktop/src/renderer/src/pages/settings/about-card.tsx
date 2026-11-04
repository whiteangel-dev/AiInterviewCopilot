import { FolderOpen, Info, RefreshCw, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader, Field } from '../../components/ui/card';
import { invoke } from '../../lib/api';
import { updateText, useUpdate } from '../../lib/use-update';
import { errorMessage } from '../../lib/utils';
import { useApp } from '../../store';

export function AboutCard() {
  const info = useApp((s) => s.info);
  const engine = useApp((s) => s.engine);
  const toast = useApp((s) => s.toast);
  const update = useUpdate();
  const [checking, setChecking] = useState(false);
  if (!info) return null;

  const check = async () => {
    setChecking(true);
    try {
      await invoke('app:checkForUpdates');
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card id="about">
      <CardHeader icon={<Info />} title="About" />
      <CardBody>
        <Field label="Version" description={info.isPackaged ? undefined : 'Development build'}>
          <span className="text-sm text-muted-foreground">{info.version}</span>
        </Field>
        <Field label="Updates" description={update ? updateText(update) : undefined}>
          {update?.state === 'ready' ? (
            <Button
              size="sm"
              onClick={() =>
                void invoke('app:installUpdate').catch((err: unknown) =>
                  toast('error', errorMessage(err)),
                )
              }
            >
              <RotateCw aria-hidden /> Restart to update
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={checking || update?.state === 'checking'}
              disabled={!update || update.state === 'disabled' || update.state === 'downloading'}
              onClick={() => void check()}
            >
              <RefreshCw aria-hidden /> Check now
            </Button>
          )}
        </Field>
        <Field label="Runtime">
          <span className="text-sm text-muted-foreground">
            Electron {info.versions.electron} · Chromium {info.versions.chrome.split('.')[0]}
          </span>
        </Field>
        <Field
          label="Engine"
          description={engine?.restarts ? `Restarted ${engine.restarts}×` : undefined}
        >
          <span className="text-sm text-muted-foreground">
            {engine?.state ?? 'unknown'}
            {engine?.schemaVersion ? ` · data v${engine.schemaVersion}` : ''}
          </span>
        </Field>
        <Field
          label="Logs"
          description="Useful when reporting a problem. Logs never contain your keys."
        >
          <Button variant="secondary" size="sm" onClick={() => void invoke('app:openPath', 'logs')}>
            <FolderOpen aria-hidden /> Open
          </Button>
        </Field>
      </CardBody>
    </Card>
  );
}
