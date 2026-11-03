import {
  ANSWER_CATEGORIES,
  type AnswerCategory,
  type AnswerMatch,
  type PreparedAnswer,
  type PreparedAnswerFields,
} from '@aic/ipc';
import {
  Check,
  FileUp,
  MessageSquareQuote,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../../components/empty-state';
import { JobProgress } from '../../components/job-progress';
import { Page } from '../../components/page';
import { ConfirmDialog } from '../../components/ui/alert-dialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Segmented } from '../../components/ui/segmented';
import { Select } from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { useJob } from '../../hooks/use-job';
import { invoke } from '../../lib/api';
import { cn, errorMessage } from '../../lib/utils';
import { useApp } from '../../store';

const CATEGORY_LABELS: Record<AnswerCategory, string> = {
  intro: 'Introduction',
  behavioral: 'Behavioral',
  motivation: 'Motivation',
  experience: 'Experience',
  technical: 'Technical',
  logistics: 'Logistics',
  closing: 'Closing',
  other: 'Other',
};

export function AnswersPage() {
  const profiles = useApp((s) => s.profiles);
  const selected = useApp((s) => s.answersProfileId);
  const select = useApp((s) => s.selectAnswersProfile);
  const navigate = useApp((s) => s.navigate);
  const profileId = profiles?.some((p) => p.id === selected)
    ? selected
    : (profiles?.[0]?.id ?? null);

  return (
    <Page
      title="Answer bank"
      description="Answers prepared ahead of time. Once approved, they can be shown the moment a matching question is asked, before any AI call."
    >
      {profiles === null ? null : !profileId ? (
        <EmptyState
          icon={MessageSquareQuote}
          title="Import a resume first"
          action={
            <Button onClick={() => navigate('profiles')}>
              <FileUp aria-hidden /> Go to profiles
            </Button>
          }
        >
          Prepared answers are written from your profile, so the bank needs one.
        </EmptyState>
      ) : (
        <>
          {profiles.length > 1 && (
            <Select
              className="w-72"
              aria-label="Profile"
              value={profileId}
              options={profiles.map((p) => ({ value: p.id, label: p.name }))}
              onChange={select}
            />
          )}
          <Bank key={profileId} profileId={profileId} />
        </>
      )}
    </Page>
  );
}

function Bank({ profileId }: { profileId: string }) {
  const bases = useApp((s) => s.bases) ?? [];
  const lengthSetting = useApp((s) => s.settings?.answers.length);
  const toast = useApp((s) => s.toast);
  const [answers, setAnswers] = useState<PreparedAnswer[] | null>(null);
  const [baseId, setBaseId] = useState<string | null>(bases[0]?.id ?? null);
  const [filter, setFilter] = useState<'all' | 'draft' | 'approved'>('all');
  // An answer ID, 'new' for the add form, or null.
  const [editing, setEditing] = useState<string | null>(null);
  const generate = useJob('answers:generate');

  useEffect(() => {
    let current = true;
    invoke('answers:list', { profileId }).then(
      (a) => current && setAnswers(a),
      (err: unknown) => current && toast('error', errorMessage(err)),
    );
    return () => {
      current = false;
    };
  }, [profileId, toast]);

  const reload = useCallback(
    async () => setAnswers(await invoke('answers:list', { profileId })),
    [profileId],
  );

  const runGenerate = async () => {
    const before = answers?.length ?? 0;
    try {
      const all = await generate.run({ profileId, baseId });
      if (all) {
        setAnswers(all);
        const added = all.length - before;
        toast(
          added > 0 ? 'success' : 'info',
          added > 0
            ? `Added ${added} draft answer${added === 1 ? '' : 's'}. Review and approve them.`
            : 'No new questions to add.',
        );
      }
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const save = async (answer: PreparedAnswer | null, fields: PreparedAnswerFields) => {
    try {
      if (answer) await invoke('answers:update', { id: answer.id, fields });
      else await invoke('answers:add', { profileId, fields });
      setEditing(null);
      await reload();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  if (!answers) return null;
  const drafts = answers.filter((a) => a.status === 'draft').length;
  const shown = answers.filter((a) => filter === 'all' || a.status === filter);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          icon={<Sparkles />}
          title="Prepare answers"
          description={`Drafts answers to common questions and to the ones your experience is likely to bring up. Uses your profile${bases.length ? ' and the notes you choose' : ''}, and the "${lengthSetting ?? 'standard'}" answer length from Settings.`}
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {bases.length > 0 && (
              <Select
                className="w-64"
                aria-label="Notes to use"
                value={baseId ?? 'none'}
                options={[
                  { value: 'none', label: 'No notes' },
                  ...bases.map((b) => ({ value: b.id, label: `Notes: ${b.name}` })),
                ]}
                onChange={(v) => setBaseId(v === 'none' ? null : v)}
              />
            )}
            <Button onClick={() => void runGenerate()} disabled={generate.running}>
              {answers.length ? 'Prepare more answers' : 'Prepare answers'}
            </Button>
          </div>
          <JobProgress job={generate} onCancel={generate.cancel} />
        </CardBody>
      </Card>

      <TryQuestion profileId={profileId} disabled={answers.length === 0} />

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Show"
          value={filter}
          options={[
            { value: 'all', label: `All ${answers.length}` },
            { value: 'draft', label: `Drafts ${drafts}` },
            { value: 'approved', label: `Approved ${answers.length - drafts}` },
          ]}
          onChange={setFilter}
        />
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => setEditing('new')} disabled={editing === 'new'}>
          <Plus aria-hidden /> Write your own
        </Button>
      </div>

      {editing === 'new' && (
        <AnswerEditor
          initial={{
            question: '',
            variants: [],
            category: 'other',
            answer: '',
            status: 'approved',
          }}
          onCancel={() => setEditing(null)}
          onSave={(fields) => save(null, fields)}
        />
      )}

      {answers.length === 0 && editing !== 'new' ? (
        <EmptyState icon={MessageSquareQuote} title="No prepared answers yet">
          Prepare them with AI above, or write your own.
        </EmptyState>
      ) : (
        <div className="space-y-3" data-testid="answer-list">
          {shown.map((a) =>
            editing === a.id ? (
              <AnswerEditor
                key={a.id}
                initial={a}
                onCancel={() => setEditing(null)}
                onSave={(fields) => save(a, fields)}
              />
            ) : (
              <AnswerCard
                key={a.id}
                answer={a}
                onEdit={() => setEditing(a.id)}
                onToggleApproved={() =>
                  void save(a, { ...a, status: a.status === 'approved' ? 'draft' : 'approved' })
                }
                onDelete={async () => {
                  try {
                    await invoke('answers:delete', { id: a.id });
                    await reload();
                  } catch (err) {
                    toast('error', errorMessage(err));
                  }
                }}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function AnswerText({ text }: { text: string }) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets = lines.filter((l) => /^[-•*]\s/.test(l));
  const lead = lines.filter((l) => !/^[-•*]\s/.test(l));
  return (
    <div className="text-sm leading-relaxed">
      {lead.map((l, i) => (
        <p key={i}>{l}</p>
      ))}
      {bullets.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 marker:text-muted-foreground">
          {bullets.map((b, i) => (
            <li key={i}>{b.replace(/^[-•*]\s+/, '')}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AnswerCard({
  answer,
  onEdit,
  onToggleApproved,
  onDelete,
}: {
  answer: PreparedAnswer;
  onEdit: () => void;
  onToggleApproved: () => void;
  onDelete: () => Promise<void>;
}) {
  const approved = answer.status === 'approved';
  return (
    <Card
      className={cn('group px-5 py-4', !approved && 'border-dashed')}
      data-testid="answer-card"
      data-status={answer.status}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{answer.question}</h3>
            <Badge>{CATEGORY_LABELS[answer.category]}</Badge>
            {approved ? (
              <Badge tone="success">
                <Check aria-hidden /> Approved
              </Badge>
            ) : (
              <Badge tone="warning">Draft</Badge>
            )}
          </div>
          <div className="mt-2">
            <AnswerText text={answer.answer} />
          </div>
          {answer.variants.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Also matches: {answer.variants.join(' · ')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant={approved ? 'ghost' : 'secondary'} size="sm" onClick={onToggleApproved}>
            {approved ? 'Unapprove' : 'Approve'}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Edit answer" onClick={onEdit}>
            <Pencil aria-hidden />
          </Button>
          <ConfirmDialog
            title="Delete this answer?"
            description={<p>{answer.question}</p>}
            confirmLabel="Delete"
            onConfirm={() => void onDelete()}
            trigger={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete answer"
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 aria-hidden />
              </Button>
            }
          />
        </div>
      </div>
    </Card>
  );
}

function AnswerEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: PreparedAnswerFields;
  onSave: (fields: PreparedAnswerFields) => Promise<void>;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState(initial.question);
  const [variants, setVariants] = useState(initial.variants.join('\n'));
  const [category, setCategory] = useState<AnswerCategory>(initial.category);
  const [answer, setAnswer] = useState(initial.answer);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3 rounded-xl border border-ring/40 bg-card p-4 shadow-sm"
      data-testid="answer-editor"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onSave({
          question: question.trim(),
          variants: variants
            .split('\n')
            .map((v) => v.trim())
            .filter(Boolean)
            .slice(0, 10),
          category,
          answer: answer.trim(),
          status: initial.status,
        }).finally(() => setBusy(false));
      }}
    >
      <div className="flex gap-3">
        <Input
          className="flex-1"
          placeholder="Question"
          value={question}
          maxLength={400}
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="Question"
          autoFocus
        />
        <Select
          className="w-44"
          aria-label="Category"
          value={category}
          options={ANSWER_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          onChange={(v) => setCategory(v as AnswerCategory)}
        />
      </div>
      <Textarea
        rows={5}
        placeholder={'First line you can say right away.\n- A short point\n- Another point'}
        value={answer}
        maxLength={4000}
        onChange={(e) => setAnswer(e.target.value)}
        aria-label="Answer"
      />
      <Textarea
        rows={2}
        placeholder="Other ways it might be asked, one per line (helps matching)"
        value={variants}
        onChange={(e) => setVariants(e.target.value)}
        aria-label="Other phrasings"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          loading={busy}
          disabled={question.trim().length < 3 || !answer.trim()}
        >
          Save
        </Button>
      </div>
    </form>
  );
}

function TryQuestion({ profileId, disabled }: { profileId: string; disabled: boolean }) {
  const [question, setQuestion] = useState('');
  const [matches, setMatches] = useState<AnswerMatch[] | null>(null);
  const run = async () => {
    if (!question.trim()) return;
    setMatches(await invoke('answers:match', { profileId, question }));
  };
  return (
    <Card>
      <CardHeader
        icon={<Search />}
        title="Try a question"
        description="Type a question the way an interviewer might ask it, and see which prepared answer would be used."
      />
      <CardBody className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <Input
            className="flex-1"
            value={question}
            maxLength={1000}
            placeholder="e.g. So, walk me through your background."
            onChange={(e) => {
              setQuestion(e.target.value);
              setMatches(null);
            }}
            disabled={disabled}
            aria-label="Test question"
          />
          <Button type="submit" variant="secondary" disabled={disabled || !question.trim()}>
            Match
          </Button>
        </form>
        {matches && (
          <div data-testid="match-results">
            {matches.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No prepared answer matches. During an interview, a new answer would be written for
                it.
              </p>
            ) : (
              <ul className="space-y-2">
                {matches.map((m) => (
                  <li
                    key={m.answer.id}
                    className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <Badge tone={m.score >= 0.6 ? 'success' : 'neutral'}>
                      {Math.round(m.score * 100)}%
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">{m.answer.question}</span>
                    {m.answer.status === 'draft' && (
                      <Badge tone="warning">Draft: not used live</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
