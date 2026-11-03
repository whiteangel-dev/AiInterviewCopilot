import type { ProfileDetail, ProfileSummary } from '@aic/ipc';
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Pencil,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { JobProgress } from '../../components/job-progress';
import { Page } from '../../components/page';
import { ResumeImport } from '../../components/resume-import';
import { ConfirmDialog } from '../../components/ui/alert-dialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Tabs } from '../../components/ui/tabs';
import { useJob } from '../../hooks/use-job';
import { invoke } from '../../lib/api';
import { errorMessage, timeAgo } from '../../lib/utils';
import { useApp } from '../../store';
import { ProfileEditor } from './editor';

export function ProfilesPage() {
  const profileId = useApp((s) => s.profileId);
  return profileId ? <ProfileView id={profileId} /> : <ProfileList />;
}

function ProfileList() {
  const profiles = useApp((s) => s.profiles);
  const navigate = useApp((s) => s.navigate);
  const refreshProfiles = useApp((s) => s.refreshProfiles);

  const opened = (p: ProfileDetail) => {
    void refreshProfiles();
    navigate('profiles', { profileId: p.id });
  };

  return (
    <Page
      title="Profiles"
      description="Each profile comes from one resume. Review what was extracted: answers only use what's here."
    >
      {!profiles || profiles.length === 0 ? (
        <ResumeImport variant="hero" profileId={null} onImported={opened} />
      ) : (
        <>
          <div className="space-y-3" data-testid="profile-list">
            {profiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                onOpen={() => navigate('profiles', { profileId: p.id })}
              />
            ))}
          </div>
          <ResumeImport
            variant="button"
            label="Import another resume"
            profileId={null}
            onImported={opened}
          />
        </>
      )}
    </Page>
  );
}

function ProfileCard({ profile, onOpen }: { profile: ProfileSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="block w-full text-left">
      <Card className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/50">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <FileText className="size-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{profile.name}</span>
            {profile.unverifiedCount > 0 && (
              <Badge tone="warning">
                <TriangleAlert aria-hidden /> {profile.unverifiedCount} to review
              </Badge>
            )}
          </div>
          <p className="truncate text-[13px] text-muted-foreground">
            {[profile.headline, profile.document?.fileName, `updated ${timeAgo(profile.updatedAt)}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </Card>
    </button>
  );
}

const ORIGIN_LABEL = { extracted: 'Analyzed', edited: 'Edited', restored: 'Restored' } as const;

function ProfileView({ id }: { id: string }) {
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const refreshProfiles = useApp((s) => s.refreshProfiles);
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('profile');
  const [renaming, setRenaming] = useState(false);
  const reanalyze = useJob('profiles:reanalyze');

  useEffect(() => {
    let current = true;
    invoke('profiles:get', { id }).then(
      (d) => current && setDetail(d),
      (err: unknown) => current && setError(errorMessage(err)),
    );
    return () => {
      current = false;
    };
  }, [id]);

  const updated = useCallback(
    (d: ProfileDetail) => {
      setDetail(d);
      void refreshProfiles();
    },
    [refreshProfiles],
  );

  if (error) {
    return (
      <Page title="Profile">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="secondary" onClick={() => navigate('profiles')}>
          Back to profiles
        </Button>
      </Page>
    );
  }
  if (!detail) return null;

  const runReanalyze = async () => {
    try {
      const d = await reanalyze.run({ id });
      if (d) {
        updated(d);
        toast('success', `Re-analyzed. Saved as version ${d.current.version}.`);
      }
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const remove = async () => {
    try {
      await invoke('profiles:delete', { id });
      await refreshProfiles();
      navigate('profiles');
      toast('success', 'Profile deleted.');
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const doc = detail.document;
  return (
    <div className="mx-auto w-full max-w-3xl px-10 pt-2 pb-16">
      <button
        type="button"
        onClick={() => navigate('profiles')}
        className="mb-3 flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Profiles
      </button>
      <header className="mb-5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-display text-2xl font-semibold tracking-tight">
              {detail.name}
            </h1>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Rename profile"
              onClick={() => setRenaming(true)}
            >
              <Pencil aria-hidden />
            </Button>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {[
              doc ? `From ${doc.fileName}` : null,
              `version ${detail.current.version}`,
              `${ORIGIN_LABEL[detail.current.origin].toLowerCase()} ${timeAgo(detail.current.createdAt)}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {doc && (
            <ConfirmDialog
              title="Analyze the resume again?"
              description={
                <p>
                  This creates a new version from the resume file. Your current version stays in
                  History, so you can restore it.
                </p>
              }
              confirmLabel="Analyze again"
              onConfirm={() => void runReanalyze()}
              trigger={
                <Button variant="secondary" disabled={reanalyze.running}>
                  <RotateCcw aria-hidden /> Re-analyze
                </Button>
              }
            />
          )}
          <ConfirmDialog
            title={`Delete "${detail.name}"?`}
            description={
              <p>
                This deletes the profile, its resume file, every version, and its prepared answers.
                It can't be undone.
              </p>
            }
            confirmLabel="Delete profile"
            onConfirm={() => void remove()}
            trigger={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete profile"
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 aria-hidden />
              </Button>
            }
          />
        </div>
      </header>

      {reanalyze.running && (
        <JobProgress job={reanalyze} onCancel={reanalyze.cancel} className="mb-5" />
      )}

      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          {
            value: 'profile',
            label: 'Profile',
            content: <ProfileEditor key={detail.current.id} detail={detail} onSaved={updated} />,
          },
          {
            value: 'resume',
            label: 'Resume text',
            content: <ResumeText id={id} versionKey={detail.current.id} />,
          },
          {
            value: 'brief',
            label: 'What the AI sees',
            content: (
              <div>
                <p className="mb-3 text-sm text-muted-foreground">
                  Answers use this summary of your profile (about{' '}
                  {detail.current.briefTokens.toLocaleString()} tokens). It's rebuilt whenever you
                  save.
                </p>
                <pre
                  className="rounded-xl border border-border bg-muted/40 p-5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap"
                  data-testid="brief"
                >
                  {detail.current.brief}
                </pre>
              </div>
            ),
          },
          {
            value: 'history',
            label: 'History',
            content: <History detail={detail} onRestored={updated} />,
          },
        ]}
      />

      {doc && tab === 'resume' && (
        <div className="mt-6">
          <ResumeImport
            variant="button"
            label="Replace with a new resume"
            profileId={id}
            onImported={updated}
          />
        </div>
      )}

      <RenameDialog
        key={String(renaming)}
        open={renaming}
        name={detail.name}
        onClose={() => setRenaming(false)}
        onSave={async (name) => {
          updated(await invoke('profiles:rename', { id, name }));
          setRenaming(false);
        }}
      />
    </div>
  );
}

function ResumeText({ id, versionKey }: { id: string; versionKey: string }) {
  const [text, setText] = useState<{ text: string; textQuality: string } | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let current = true;
    invoke('profiles:resumeText', { id }).then(
      (t) => current && setText(t),
      () => current && setText(null),
    );
    return () => {
      current = false;
    };
  }, [id, versionKey]);
  if (text === undefined) return null;
  if (!text) return <p className="text-sm text-muted-foreground">No resume file.</p>;
  if (text.textQuality === 'none') {
    return (
      <p className="text-sm text-muted-foreground">
        This PDF has no text layer (it may be a scan or an image), so there's no text to show.
        Gemini read the page images instead.
      </p>
    );
  }
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        The text read from your file on this computer. Statements are checked against it.
      </p>
      <pre className="max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-muted/40 p-5 font-sans text-[13px] leading-relaxed whitespace-pre-wrap">
        {text.text}
      </pre>
    </div>
  );
}

function History({
  detail,
  onRestored,
}: {
  detail: ProfileDetail;
  onRestored: (d: ProfileDetail) => void;
}) {
  const toast = useApp((s) => s.toast);
  const restore = async (versionId: string, version: number) => {
    try {
      const d = await invoke('profiles:restoreVersion', { id: detail.id, versionId });
      onRestored(d);
      toast('success', `Restored version ${version} as version ${d.current.version}.`);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };
  return (
    <Card>
      <ol>
        {detail.versions.map((v) => (
          <li
            key={v.id}
            className="flex items-center gap-4 border-t border-border px-5 py-3.5 first:border-t-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                Version {v.version}
                {v.id === detail.current.id && <Badge tone="accent">Current</Badge>}
              </div>
              <p className="text-[13px] text-muted-foreground">
                {ORIGIN_LABEL[v.origin]}
                {v.model ? ` with ${v.model}` : ''} · {timeAgo(v.createdAt)}
              </p>
            </div>
            {v.id !== detail.current.id && (
              <Button variant="secondary" size="sm" onClick={() => void restore(v.id, v.version)}>
                Restore
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function RenameDialog({
  open,
  name,
  onClose,
  onSave,
}: {
  open: boolean;
  name: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
        else setValue(name);
      }}
      title="Rename profile"
      description="Useful when you keep one resume per kind of role."
      className="w-[min(440px,calc(100vw-32px))]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!value.trim()}
            onClick={() => {
              setBusy(true);
              void onSave(value.trim()).finally(() => setBusy(false));
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Input
        value={value}
        maxLength={120}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Profile name"
        autoFocus
      />
    </Dialog>
  );
}
