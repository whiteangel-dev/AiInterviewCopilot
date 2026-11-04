import { Eye, EyeOff, FileKey2, KeyRound, Share2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { CreateKeyFileDialog, KeyFileImport } from '../../components/key-file';
import { ConfirmDialog } from '../../components/ui/alert-dialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { invoke } from '../../lib/api';
import { dateText, errorMessage, timeAgo } from '../../lib/utils';
import { useApp } from '../../store';

const AI_STUDIO_KEYS_URL = 'https://aistudio.google.com/apikey';

/** For the key's owner: give someone access through an encrypted key file. */
export function ShareKeyCard() {
  const [open, setOpen] = useState(false);
  return (
    <Card id="share-key">
      <CardHeader
        icon={<Share2 />}
        title="Share your key"
        description="Let someone else use the app with your Gemini key, without sending the key in plain text: an encrypted key file plus a password you send separately."
        action={
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Create key file
          </Button>
        }
      />
      <CreateKeyFileDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

export function ApiKeyCard() {
  const status = useApp((s) => s.apiKey);
  const info = useApp((s) => s.info);
  const setApiKey = useApp((s) => s.setApiKey);
  const toast = useApp((s) => s.toast);

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<'save' | 'check' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const configured = !!status?.configured;
  const showForm = !configured || editing;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError(null);
    try {
      const next = await invoke('apiKey:save', { provider: 'gemini', key: value });
      setApiKey(next);
      setValue('');
      setReveal(false);
      setEditing(false);
      if (next.verification === 'valid') toast('success', 'API key saved and verified.');
      else toast('info', `API key saved, but it couldn't be checked yet. ${next.message ?? ''}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const recheck = async () => {
    setBusy('check');
    try {
      const next = await invoke('apiKey:verify', { provider: 'gemini' });
      setApiKey(next);
      if (next.verification === 'valid') toast('success', 'The key works.');
      else toast('error', next.message ?? 'The key could not be verified.');
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      setApiKey(await invoke('apiKey:remove', { provider: 'gemini' }));
      toast('success', 'API key removed from this computer.');
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const badge = !configured ? (
    <Badge>Not set</Badge>
  ) : status.expired ? (
    <Badge tone="danger">Expired</Badge>
  ) : status.verification === 'valid' ? (
    <Badge tone="success">Verified</Badge>
  ) : status.verification === 'invalid' ? (
    <Badge tone="danger">Rejected</Badge>
  ) : (
    <Badge tone="warning">Not verified</Badge>
  );

  const protectedBy =
    info?.secureStorage === 'os'
      ? info.platform === 'darwin'
        ? 'the macOS Keychain'
        : 'Windows credential encryption'
      : null;

  return (
    <Card id="api-key" data-testid="api-key-card">
      <CardHeader
        icon={<KeyRound />}
        title="Gemini API key"
        description="Powers transcription and answers. Google bills your account directly for what you use."
        action={badge}
      />
      <CardBody className="space-y-4">
        {configured && !editing && (
          <div className="flex items-center gap-4 rounded-lg border border-border bg-background px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-sm tracking-wider" data-testid="api-key-hint">
                ••••••••••••{status.hint}
              </div>
              <p
                className={
                  status.verification === 'invalid'
                    ? 'mt-0.5 text-[13px] text-destructive'
                    : 'mt-0.5 text-[13px] text-muted-foreground'
                }
              >
                {status.verification === 'valid' && status.checkedAt
                  ? `Checked ${timeAgo(status.checkedAt)}`
                  : (status.message ?? 'Not checked yet')}
              </p>
              {status.source === 'file' && (
                <p
                  className={
                    status.expired
                      ? 'mt-0.5 flex items-center gap-1.5 text-[13px] text-destructive'
                      : 'mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground'
                  }
                  data-testid="key-origin"
                >
                  <FileKey2 className="size-3.5" aria-hidden />
                  From a key file{status.label ? ` (${status.label})` : ''}
                  {status.expiresAt &&
                    (status.expired
                      ? `, expired on ${dateText(status.expiresAt)}`
                      : `, works until ${dateText(status.expiresAt)}`)}
                </p>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'check'}
              disabled={busy !== null}
              onClick={() => void recheck()}
            >
              Check again
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setEditing(true);
                setError(null);
              }}
            >
              Replace
            </Button>
            <ConfirmDialog
              title="Remove the API key?"
              description={
                <p>The copilot won't be able to transcribe or answer until you add a key again.</p>
              }
              confirmLabel="Remove key"
              busy={busy === 'remove'}
              onConfirm={() => void remove()}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  className="text-destructive"
                >
                  Remove
                </Button>
              }
            />
          </div>
        )}

        {showForm && (
          <form onSubmit={(e) => void save(e)} className="space-y-2" noValidate>
            <label htmlFor="api-key-input" className="text-sm font-medium">
              {configured ? 'New API key' : 'API key'}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="api-key-input"
                  type={reveal ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setError(null);
                  }}
                  placeholder="Paste your key, e.g. AIza…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'api-key-error' : undefined}
                  className="pr-10 font-mono"
                  disabled={busy === 'save'}
                />
                <button
                  type="button"
                  onClick={() => setReveal((r) => !r)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                  aria-label={reveal ? 'Hide key' : 'Show key'}
                >
                  {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <Button type="submit" loading={busy === 'save'} disabled={value.trim().length < 20}>
                {busy === 'save' ? 'Checking…' : 'Save key'}
              </Button>
              {editing && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setValue('');
                    setError(null);
                  }}
                  disabled={busy === 'save'}
                >
                  Cancel
                </Button>
              )}
            </div>
            {error && (
              <p id="api-key-error" className="text-[13px] text-destructive" role="alert">
                {error}
              </p>
            )}
            <p className="text-[13px] text-muted-foreground">
              Don't have one?{' '}
              <Button
                variant="link"
                className="text-[13px]"
                onClick={() => void invoke('app:openExternal', AI_STUDIO_KEYS_URL)}
              >
                Create a key in Google AI Studio
              </Button>
              . We check it with Google before saving.
            </p>
          </form>
        )}

        {(showForm || importing) && (
          <div className="space-y-2 border-t border-border pt-4">
            <div className="text-sm font-medium">Have a key file?</div>
            <p className="text-[13px] text-muted-foreground">
              If someone gave you a key file, choose it and enter the password they sent you.
            </p>
            <KeyFileImport onDone={() => setImporting(false)} />
          </div>
        )}

        <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
          {protectedBy ? (
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          ) : (
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          )}
          {protectedBy
            ? `Stored only on this computer, encrypted with ${protectedBy}. Sent only to Google.`
            : 'This system has no secure keyring, so the key is stored with basic protection. Sent only to Google.'}
        </p>
      </CardBody>
    </Card>
  );
}
