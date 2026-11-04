import { ExternalLink } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { invoke } from '../lib/api';
import { errorMessage } from '../lib/utils';
import { useApp } from '../store';
import { Button } from './ui/button';
import { Input } from './ui/input';

export const AI_STUDIO_KEYS_URL = 'https://aistudio.google.com/apikey';

/**
 * The first step for a new user: get a free Gemini key and paste it, without
 * leaving the page.
 */
export function QuickKey() {
  const setApiKey = useApp((s) => s.setApiKey);
  const toast = useApp((s) => s.toast);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await invoke('apiKey:save', { provider: 'gemini', key: value });
      setApiKey(next);
      setValue('');
      if (next.verification === 'valid') toast('success', 'Connected to Gemini.');
      else toast('info', `Key saved, but it couldn't be checked yet. ${next.message ?? ''}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3" data-testid="quick-key">
      <ol className="list-decimal space-y-0.5 pl-5 text-[13px] text-muted-foreground">
        <li>
          Open Google AI Studio and sign in with any Google account.{' '}
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            onClick={() =>
              void invoke('app:openExternal', AI_STUDIO_KEYS_URL).catch((err: unknown) =>
                toast('error', errorMessage(err)),
              )
            }
          >
            Get a free key <ExternalLink className="size-3" aria-hidden />
          </button>
        </li>
        <li>Click “Create API key”, then copy it.</li>
        <li>Paste it here.</li>
      </ol>
      <form onSubmit={(e) => void save(e)} className="flex gap-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste your Gemini API key"
          aria-label="Gemini API key"
          autoComplete="off"
          spellCheck={false}
          className="max-w-sm font-mono"
        />
        <Button type="submit" size="sm" className="h-9" loading={busy} disabled={!value.trim()}>
          Connect
        </Button>
      </form>
      {error && (
        <p className="text-[13px] text-destructive" role="alert">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Free keys work: everything the copilot does live runs on Google's free tier, within its
        usage limits. Your key stays on this computer.
      </p>
    </div>
  );
}
