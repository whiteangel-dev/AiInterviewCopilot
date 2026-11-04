import { FileKey2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { invoke } from '../lib/api';
import { dateText, errorMessage } from '../lib/utils';
import { useApp } from '../store';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Input } from './ui/input';

export const KEY_FILE_ACCEPT = '.aickey';

/**
 * Imports an encrypted key file someone gave you, with the password they sent
 * separately. The key itself is never shown.
 */
export function KeyFileImport({ onDone }: { onDone?: () => void }) {
  const setApiKey = useApp((s) => s.setApiKey);
  const toast = useApp((s) => s.toast);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const next = await invoke('apiKey:importFile', { provider: 'gemini', data, password });
      setApiKey(next);
      setPassword('');
      setFile(null);
      toast(
        'success',
        `Key file imported${next.label ? ` (${next.label})` : ''}.${next.expiresAt ? ` It works until ${dateText(next.expiresAt)}.` : ''}`,
      );
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2" data-testid="key-file-import">
      <input
        ref={input}
        type="file"
        accept={KEY_FILE_ACCEPT}
        className="hidden"
        aria-label="Key file"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setError(null);
          e.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => input.current?.click()}>
          <FileKey2 aria-hidden /> {file ? 'Choose another file' : 'Choose key file'}
        </Button>
        {file && (
          <span className="truncate text-[13px] text-muted-foreground" data-testid="key-file-name">
            {file.name}
          </span>
        )}
      </div>
      {file && (
        <div className="flex gap-2">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password for the key file"
            aria-label="Key file password"
            autoComplete="off"
            className="max-w-xs"
            autoFocus
          />
          <Button type="submit" size="sm" className="h-9" loading={busy} disabled={!password}>
            Import
          </Button>
        </div>
      )}
      {error && (
        <p className="text-[13px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * For the key's owner: encrypts a key into a file to give someone, with a
 * password to send separately and an optional end date.
 */
export function CreateKeyFileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useApp((s) => s.toast);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && confirm !== password;
  const canSave = key.trim().length > 0 && password.length >= 8 && password === confirm;

  const reset = () => {
    setKey('');
    setLabel('');
    setPassword('');
    setConfirm('');
    setUntil('');
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // The key works through the end of the chosen day.
      const expiresAt = until ? new Date(`${until}T23:59:59`).getTime() : null;
      const { saved } = await invoke('apiKey:createFile', {
        provider: 'gemini',
        key: key.trim(),
        password,
        label: label.trim(),
        expiresAt,
      });
      if (saved) {
        toast('success', 'Key file saved. Send the password separately, for example by phone.');
        reset();
        onOpenChange(false);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Create a key file"
      description="Give someone access to your Gemini key without sending it in plain text."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!canSave}>
            Save key file
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="create-key-file">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Key to share</span>
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste a Gemini API key"
            aria-label="Key to share"
            autoComplete="off"
            className="font-mono"
          />
          <span className="block text-xs text-muted-foreground">
            Best: create a separate key for each person in Google AI Studio, so you can delete just
            theirs when you're done.
          </span>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">For</span>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
            placeholder="Alex Kim"
            aria-label="Who it's for"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Password</span>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              aria-label="Password"
              autoComplete="new-password"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Repeat password</span>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-label="Repeat password"
              autoComplete="new-password"
            />
          </label>
        </div>
        {mismatch && <p className="text-xs text-destructive">The passwords don't match.</p>}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Works until (optional)</span>
          <Input
            type="date"
            value={until}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setUntil(e.target.value)}
            aria-label="Works until"
            className="w-48"
          />
        </label>
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          The app never shows the key to the person you give it to, and the file is useless without
          the password. Someone with technical skill could still extract the key from the running
          app, so treat it as shared: you can delete it in Google AI Studio at any time.
        </p>
        {error && (
          <p className="text-[13px] text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
