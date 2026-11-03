import {
  KNOWLEDGE_CATEGORIES,
  type ContextPreview,
  type KnowledgeAnalysis,
  type KnowledgeBaseDetail,
  type KnowledgeItem,
  type KnowledgeItemFields,
} from '@aic/ipc';
import {
  CircleCheck,
  Eye,
  NotebookPen,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wand2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from '../../components/empty-state';
import { JobProgress } from '../../components/job-progress';
import { Page } from '../../components/page';
import { ConfirmDialog } from '../../components/ui/alert-dialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader } from '../../components/ui/card';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Select } from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { useJob } from '../../hooks/use-job';
import { invoke } from '../../lib/api';
import { cn, errorMessage, timeAgo } from '../../lib/utils';
import { useApp } from '../../store';
import { ItemEditor } from './item-editor';
import { CATEGORY_LABELS, EMPTY_ITEM, ISSUE_LABELS, KIND_LABELS } from './labels';

export function KnowledgePage() {
  const bases = useApp((s) => s.bases);
  const baseId = useApp((s) => s.baseId);
  return (
    <Page
      title="Application knowledge"
      description="What the copilot should know beyond your resume: project stories, salary expectations, how you like to answer. Facts are true statements about you; instructions say how to answer."
    >
      {bases === null ? null : bases.length === 0 || !baseId ? (
        <FirstBase />
      ) : (
        <BaseView key={baseId} id={baseId} />
      )}
    </Page>
  );
}

function FirstBase() {
  const refreshBases = useApp((s) => s.refreshBases);
  const selectBase = useApp((s) => s.selectBase);
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState('My job search');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const base = await invoke('knowledge:createBase', { name, description: '' });
      await refreshBases();
      selectBase(base.id);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <EmptyState
      icon={NotebookPen}
      title="Start your knowledge base"
      action={
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input
            className="w-64"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            aria-label="Knowledge base name"
          />
          <Button type="submit" loading={busy} disabled={!name.trim()}>
            Create
          </Button>
        </form>
      }
    >
      Keep one for everything, or one per application (for example, "Kestrel Pay") with the company
      details and the answers you want to give there.
    </EmptyState>
  );
}

function BaseView({ id }: { id: string }) {
  const bases = useApp((s) => s.bases) ?? [];
  const profiles = useApp((s) => s.profiles) ?? [];
  const selectBase = useApp((s) => s.selectBase);
  const refreshBases = useApp((s) => s.refreshBases);
  const toast = useApp((s) => s.toast);
  const [detail, setDetail] = useState<KnowledgeBaseDetail | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [baseDialog, setBaseDialog] = useState<'new' | 'rename' | null>(null);
  const [profileId, setProfileId] = useState<string | null>(profiles[0]?.id ?? null);
  const analyze = useJob('knowledge:analyze');

  const reload = useCallback(async () => {
    try {
      setDetail(await invoke('knowledge:getBase', { id }));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }, [id, toast]);

  useEffect(() => {
    let current = true;
    invoke('knowledge:getBase', { id }).then(
      (d) => current && setDetail(d),
      (err: unknown) => current && toast('error', errorMessage(err)),
    );
    return () => {
      current = false;
    };
  }, [id, toast]);

  const changed = async () => {
    await reload();
    void refreshBases();
  };

  const runAnalysis = async () => {
    try {
      const result = await analyze.run({ baseId: id, profileId });
      if (result) {
        await reload();
        toast(
          result.issues.length ? 'info' : 'success',
          result.issues.length
            ? `Found ${result.issues.length} thing${result.issues.length === 1 ? '' : 's'} to look at.`
            : 'No problems found.',
        );
      }
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const issuesByItem = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of detail?.analysis?.issues ?? [])
      for (const itemId of issue.itemIds) map.set(itemId, (map.get(itemId) ?? 0) + 1);
    return map;
  }, [detail]);

  if (!detail) return null;

  const groups = [
    {
      key: 'instructions',
      title: 'Answer instructions',
      items: detail.items.filter((i) => i.kind === 'instruction'),
    },
    ...KNOWLEDGE_CATEGORIES.map((c) => ({
      key: c,
      title: CATEGORY_LABELS[c],
      items: detail.items.filter((i) => i.kind === 'fact' && i.category === c),
    })),
  ].filter((g) => g.items.length > 0);

  return (
    <div className="space-y-5" data-testid="knowledge-base">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-64"
          aria-label="Knowledge base"
          value={id}
          options={bases.map((b) => ({ value: b.id, label: b.name, hint: `${b.itemCount}` }))}
          onChange={selectBase}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Rename knowledge base"
          onClick={() => setBaseDialog('rename')}
        >
          <Pencil aria-hidden />
        </Button>
        <ConfirmDialog
          title={`Delete "${detail.name}"?`}
          description={
            <p>
              This deletes the knowledge base and its {detail.items.length} notes. It can't be
              undone.
            </p>
          }
          confirmLabel="Delete"
          onConfirm={() =>
            void invoke('knowledge:deleteBase', { id })
              .then(refreshBases)
              .catch((err: unknown) => toast('error', errorMessage(err)))
          }
          trigger={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete knowledge base"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 aria-hidden />
            </Button>
          }
        />
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setBaseDialog('new')}>
          <Plus aria-hidden /> New base
        </Button>
      </div>
      {detail.description && (
        <p className="-mt-2 text-sm text-muted-foreground">{detail.description}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            setAdding(true);
            setEditingId(null);
          }}
          disabled={adding}
        >
          <Plus aria-hidden /> Add note
        </Button>
        <Button variant="secondary" onClick={() => setNotesOpen(true)}>
          <Wand2 aria-hidden /> Add from text
        </Button>
        <Button variant="secondary" onClick={() => setPreviewOpen(true)}>
          <Eye aria-hidden /> Preview
        </Button>
      </div>

      {adding && (
        <ItemEditor
          initial={EMPTY_ITEM}
          saveLabel="Add"
          onCancel={() => setAdding(false)}
          onSave={async (fields) => {
            try {
              await invoke('knowledge:addItems', { baseId: id, items: [fields] });
              setAdding(false);
              await changed();
            } catch (err) {
              toast('error', errorMessage(err));
            }
          }}
        />
      )}

      <AnalysisCard
        detail={detail}
        running={analyze.running}
        profileId={profileId}
        onProfileChange={setProfileId}
        onRun={() => void runAnalysis()}
        onApplyClassification={async (item, fields) => {
          try {
            await invoke('knowledge:updateItem', { id: item.id, fields });
            await changed();
          } catch (err) {
            toast('error', errorMessage(err));
          }
        }}
      >
        <JobProgress job={analyze} onCancel={analyze.cancel} />
      </AnalysisCard>

      {detail.items.length === 0 && !adding ? (
        <EmptyState icon={NotebookPen} title="No notes yet">
          Add what you'd want a friend coaching you to know: the story behind a project, why you're
          leaving, your salary range, topics to avoid.
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section key={g.key} aria-label={g.title}>
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {g.title}
            </h2>
            <div className="space-y-2">
              {g.items.map((item) =>
                editingId === item.id ? (
                  <ItemEditor
                    key={item.id}
                    initial={item}
                    onCancel={() => setEditingId(null)}
                    onSave={async (fields) => {
                      try {
                        await invoke('knowledge:updateItem', { id: item.id, fields });
                        setEditingId(null);
                        await changed();
                      } catch (err) {
                        toast('error', errorMessage(err));
                      }
                    }}
                  />
                ) : (
                  <ItemCard
                    key={item.id}
                    item={item}
                    issues={issuesByItem.get(item.id) ?? 0}
                    onEdit={() => {
                      setEditingId(item.id);
                      setAdding(false);
                    }}
                    onDelete={async () => {
                      try {
                        await invoke('knowledge:deleteItem', { id: item.id });
                        await changed();
                      } catch (err) {
                        toast('error', errorMessage(err));
                      }
                    }}
                  />
                ),
              )}
            </div>
          </section>
        ))
      )}

      <NotesDialog
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        baseId={id}
        onAdded={changed}
      />
      {previewOpen && <PreviewDialog baseId={id} onClose={() => setPreviewOpen(false)} />}
      {baseDialog && (
        <BaseDialog
          mode={baseDialog}
          detail={detail}
          onClose={() => setBaseDialog(null)}
          onDone={async (newId) => {
            setBaseDialog(null);
            await refreshBases();
            if (newId) selectBase(newId);
            else await reload();
          }}
        />
      )}
    </div>
  );
}

function ItemCard({
  item,
  issues,
  onEdit,
  onDelete,
}: {
  item: KnowledgeItem;
  issues: number;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  return (
    <Card
      id={`item-${item.id}`}
      className={cn('group flex gap-3 px-4 py-3', issues > 0 && 'ring-1 ring-warning/40')}
      data-testid="knowledge-item"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {item.title && <span className="text-sm font-medium">{item.title}</span>}
          <Badge tone={item.kind === 'instruction' ? 'accent' : 'neutral'}>
            {KIND_LABELS[item.kind]}
          </Badge>
          {item.kind === 'instruction' && <Badge>{CATEGORY_LABELS[item.category]}</Badge>}
          {issues > 0 && (
            <Badge tone="warning">
              <TriangleAlert aria-hidden /> Review
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm whitespace-pre-wrap text-foreground/90">{item.content}</p>
      </div>
      <div className="flex shrink-0 items-start gap-1 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button variant="ghost" size="icon" aria-label="Edit note" onClick={onEdit}>
          <Pencil aria-hidden />
        </Button>
        <ConfirmDialog
          title="Delete this note?"
          description={<p className="line-clamp-3">{item.title || item.content}</p>}
          confirmLabel="Delete"
          onConfirm={() => void onDelete()}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete note"
              className="hover:text-destructive"
            >
              <Trash2 aria-hidden />
            </Button>
          }
        />
      </div>
    </Card>
  );
}

function AnalysisCard({
  detail,
  running,
  profileId,
  onProfileChange,
  onRun,
  onApplyClassification,
  children,
}: {
  detail: KnowledgeBaseDetail;
  running: boolean;
  profileId: string | null;
  onProfileChange: (id: string | null) => void;
  onRun: () => void;
  onApplyClassification: (item: KnowledgeItem, fields: KnowledgeItemFields) => Promise<void>;
  children: ReactNode;
}) {
  const profiles = useApp((s) => s.profiles) ?? [];
  const analysis: KnowledgeAnalysis | null = detail.analysis;
  const itemTitle = (itemId: string) => {
    const item = detail.items.find((i) => i.id === itemId);
    return item
      ? item.title || `${item.content.slice(0, 48)}${item.content.length > 48 ? '…' : ''}`
      : 'deleted note';
  };
  const scrollTo = (itemId: string) =>
    document
      .getElementById(`item-${itemId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <Card data-testid="analysis-card">
      <CardHeader
        icon={<Sparkles />}
        title="Review with AI"
        description="Finds duplicates, contradictions with your resume, vague notes, and instructions that could make answers claim things you didn't do."
      />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {profiles.length > 0 && (
            <Select
              className="w-64"
              aria-label="Compare with profile"
              value={profileId ?? 'none'}
              options={[
                { value: 'none', label: "Don't compare with a resume" },
                ...profiles.map((p) => ({ value: p.id, label: `Compare with ${p.name}` })),
              ]}
              onChange={(v) => onProfileChange(v === 'none' ? null : v)}
            />
          )}
          <Button onClick={onRun} disabled={running || detail.items.length === 0}>
            {analysis ? 'Review again' : 'Review notes'}
          </Button>
        </div>
        {children}
        {analysis && !running && (
          <div className="space-y-3" data-testid="analysis-result">
            {analysis.stale && (
              <p className="text-[13px] text-warning">
                Your notes changed since this review ({timeAgo(analysis.createdAt)}). Review again
                to update it.
              </p>
            )}
            <p className="text-sm">
              {analysis.issues.length === 0 && (
                <CircleCheck className="mr-1.5 inline size-4 text-success" aria-hidden />
              )}
              {analysis.summary}
            </p>
            {analysis.issues.map((issue, i) => (
              <div
                key={i}
                className="rounded-lg border border-border bg-background px-4 py-3"
                data-testid="analysis-issue"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      issue.type === 'risky' || issue.type === 'conflict' ? 'danger' : 'warning'
                    }
                  >
                    {ISSUE_LABELS[issue.type]}
                  </Badge>
                  {issue.involvesResume && <Badge>Resume</Badge>}
                  {issue.itemIds.map((itemId) => (
                    <button
                      key={itemId}
                      type="button"
                      onClick={() => scrollTo(itemId)}
                      className="text-[13px] text-primary hover:underline"
                    >
                      {itemTitle(itemId)}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-sm">{issue.message}</p>
                {issue.suggestion && (
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    Suggestion: {issue.suggestion}
                  </p>
                )}
              </div>
            ))}
            {analysis.reclassify.map((r) => {
              const item = detail.items.find((i) => i.id === r.itemId);
              if (!item) return null;
              return (
                <div
                  key={r.itemId}
                  className="flex items-center gap-3 rounded-lg border border-border px-4 py-2.5 text-sm"
                >
                  <p className="min-w-0 flex-1 truncate">
                    File <span className="font-medium">{itemTitle(item.id)}</span> as{' '}
                    {KIND_LABELS[r.kind].toLowerCase()} · {CATEGORY_LABELS[r.category]}?
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void onApplyClassification(item, {
                        ...item,
                        kind: r.kind,
                        category: r.category,
                      })
                    }
                  >
                    Apply
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function NotesDialog({
  open,
  onClose,
  baseId,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  baseId: string;
  onAdded: () => Promise<void>;
}) {
  const toast = useApp((s) => s.toast);
  const split = useJob('knowledge:splitNotes');
  const [text, setText] = useState('');
  const [proposals, setProposals] = useState<(KnowledgeItemFields & { keep: boolean })[] | null>(
    null,
  );
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setText('');
    setProposals(null);
  };

  const organize = async () => {
    try {
      const items = await split.run({ text });
      if (items) setProposals(items.map((i) => ({ ...i, keep: true })));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const add = async () => {
    const items = (proposals ?? [])
      .filter((p) => p.keep)
      .map(({ keep: _keep, ...fields }) => fields);
    if (items.length === 0) return;
    setSaving(true);
    try {
      await invoke('knowledge:addItems', { baseId, items });
      await onAdded();
      toast('success', `Added ${items.length} note${items.length === 1 ? '' : 's'}.`);
      reset();
      onClose();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const kept = proposals?.filter((p) => p.keep).length ?? 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          split.cancel();
          onClose();
        }
      }}
      title="Add from text"
      description="Paste notes in any format. They're split into separate notes for you to check before anything is saved."
      footer={
        proposals ? (
          <>
            <Button variant="ghost" onClick={() => setProposals(null)} disabled={saving}>
              Back
            </Button>
            <Button onClick={() => void add()} loading={saving} disabled={kept === 0}>
              Add {kept} note{kept === 1 ? '' : 's'}
            </Button>
          </>
        ) : (
          <Button onClick={() => void organize()} disabled={!text.trim() || split.running}>
            Organize
          </Button>
        )
      }
    >
      {proposals ? (
        <ul className="space-y-2" data-testid="proposals">
          {proposals.map((p, i) => (
            <li key={i}>
              <label
                className={cn(
                  'flex gap-3 rounded-lg border border-border px-3 py-2.5',
                  !p.keep && 'opacity-50',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--primary)]"
                  checked={p.keep}
                  onChange={(e) =>
                    setProposals((list) =>
                      list!.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)),
                    )
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    {p.title && <span className="text-sm font-medium">{p.title}</span>}
                    <Badge tone={p.kind === 'instruction' ? 'accent' : 'neutral'}>
                      {KIND_LABELS[p.kind]}
                    </Badge>
                    <Badge>{CATEGORY_LABELS[p.category]}</Badge>
                  </span>
                  <span className="mt-1 block text-sm whitespace-pre-wrap">{p.content}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-3">
          <Textarea
            rows={10}
            maxRows={18}
            value={text}
            maxLength={30000}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "- Why I'm leaving: the platform work is now mostly maintenance…\n- Salary: ask for their range first. Target base $185k–$205k.\n- Never bring up the 2020 layoffs unless asked."
            }
            aria-label="Notes"
            disabled={split.running}
          />
          <JobProgress job={split} onCancel={split.cancel} />
        </div>
      )}
    </Dialog>
  );
}

function PreviewDialog({ baseId, onClose }: { baseId: string; onClose: () => void }) {
  const profiles = useApp((s) => s.profiles) ?? [];
  const [profileId, setProfileId] = useState<string | null>(profiles[0]?.id ?? null);
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  useEffect(() => {
    let current = true;
    invoke('context:preview', { profileId, baseId }).then(
      (p) => current && setPreview(p),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [profileId, baseId]);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="What the AI sees"
      description="Your profile and these notes, exactly as they're given to the answer model during an interview."
      className="w-[min(760px,calc(100vw-32px))]"
    >
      <div className="mb-3 flex items-center gap-3">
        {profiles.length > 0 && (
          <Select
            className="w-64"
            aria-label="Profile"
            value={profileId ?? 'none'}
            options={[
              { value: 'none', label: 'No profile' },
              ...profiles.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(v) => setProfileId(v === 'none' ? null : v)}
          />
        )}
        {preview && (
          <span className="text-[13px] text-muted-foreground">
            About {preview.approxTokens.toLocaleString()} tokens
          </span>
        )}
      </div>
      <pre
        className="rounded-xl border border-border bg-muted/40 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap"
        data-testid="context-preview"
      >
        {preview?.text ?? ''}
      </pre>
    </Dialog>
  );
}

function BaseDialog({
  mode,
  detail,
  onClose,
  onDone,
}: {
  mode: 'new' | 'rename';
  detail: KnowledgeBaseDetail;
  onClose: () => void;
  onDone: (newId: string | null) => Promise<void>;
}) {
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState(mode === 'rename' ? detail.name : '');
  const [description, setDescription] = useState(mode === 'rename' ? detail.description : '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (mode === 'new') {
        const base = await invoke('knowledge:createBase', { name, description });
        await onDone(base.id);
      } else {
        await invoke('knowledge:updateBase', { id: detail.id, name, description });
        await onDone(null);
      }
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={mode === 'new' ? 'New knowledge base' : 'Rename knowledge base'}
      description="For example, one per company you're interviewing with."
      className="w-[min(480px,calc(100vw-32px))]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void save()}>
            {mode === 'new' ? 'Create' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          value={name}
          maxLength={120}
          placeholder="Name"
          onChange={(e) => setName(e.target.value)}
          aria-label="Name"
          autoFocus
        />
        <Input
          value={description}
          maxLength={500}
          placeholder="Description (optional)"
          onChange={(e) => setDescription(e.target.value)}
          aria-label="Description"
        />
      </div>
    </Dialog>
  );
}
