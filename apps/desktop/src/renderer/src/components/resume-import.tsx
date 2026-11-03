import type { ProfileDetail } from '@aic/ipc';
import { FileUp, KeyRound } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { useJob } from '../hooks/use-job';
import { cn, errorMessage } from '../lib/utils';
import { useApp } from '../store';
import { JobProgress } from './job-progress';
import { Button } from './ui/button';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Imports a resume (PDF or .docx) into a new profile, or into `profileId` as a
 * new version. `hero` is a large drop zone; `button` is a single button.
 */
export function ResumeImport({
  profileId,
  onImported,
  variant,
  label,
}: {
  profileId: string | null;
  onImported: (profile: ProfileDetail) => void;
  variant: 'hero' | 'button';
  label?: string;
}) {
  const job = useJob('profiles:import');
  const apiKey = useApp((s) => s.apiKey);
  const navigate = useApp((s) => s.navigate);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!/\.(pdf|docx)$/i.test(file.name)) {
      setError(
        /\.doc$/i.test(file.name)
          ? 'Save the file as .docx or PDF first.'
          : 'Choose a PDF or Word (.docx) file.',
      );
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('That file is larger than 10 MB.');
      return;
    }
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const profile = await job.run({ fileName: file.name, data, profileId });
      if (profile) onImported(profile);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void importFile(e.dataTransfer.files[0]);
  };

  const fileInput = (
    <input
      ref={input}
      type="file"
      accept={ACCEPT}
      className="hidden"
      data-testid="resume-file-input"
      onChange={(e) => {
        void importFile(e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );

  if (!apiKey?.configured) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="flex-1">Add your Gemini API key first. It's used to analyze the resume.</p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => navigate('settings', { section: 'api-key' })}
        >
          Add API key
        </Button>
      </div>
    );
  }

  if (job.running) return <JobProgress job={job} onCancel={job.cancel} />;

  if (variant === 'button') {
    return (
      <>
        {fileInput}
        <Button variant="secondary" onClick={() => input.current?.click()}>
          <FileUp aria-hidden /> {label ?? 'Import resume'}
        </Button>
        {error && (
          <p className="mt-2 text-[13px] text-destructive" role="alert">
            {error}
          </p>
        )}
      </>
    );
  }

  return (
    <div>
      {fileInput}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center rounded-xl border-2 border-dashed px-8 py-12 text-center transition-colors',
          dragging ? 'border-primary bg-accent/60' : 'border-border',
        )}
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <FileUp className="size-5" aria-hidden />
        </div>
        <h2 className="mt-4 text-base font-semibold">Drop your resume here</h2>
        <p className="mt-1 text-sm text-muted-foreground">PDF or Word (.docx), up to 10 MB.</p>
        <Button className="mt-5" onClick={() => input.current?.click()}>
          Choose file
        </Button>
        <p className="mt-5 max-w-md text-xs text-muted-foreground">
          The text is read on this computer. To build your profile, the file is sent to Google
          Gemini with your API key. Every statement is then checked against your resume.
        </p>
      </div>
      {error && (
        <p className="mt-3 text-[13px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
