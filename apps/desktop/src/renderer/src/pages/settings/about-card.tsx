import { FolderOpen, Info } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader, Field } from '../../components/ui/card';
import { invoke } from '../../lib/api';
import { useApp } from '../../store';

export function AboutCard() {
  const info = useApp((s) => s.info);
  const engine = useApp((s) => s.engine);
  if (!info) return null;

  return (
    <Card id="about">
      <CardHeader icon={<Info />} title="About" />
      <CardBody>
        <Field label="Version" description={info.isPackaged ? undefined : 'Development build'}>
          <span className="text-sm text-muted-foreground">{info.version}</span>
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
