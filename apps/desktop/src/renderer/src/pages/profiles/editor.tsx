import {
  countUnverified,
  type CandidateProfile,
  type ProfileDetail,
  type ProfilePoint,
} from '@aic/ipc';
import { Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { EvidenceBadge } from '../../components/evidence-badge';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { invoke } from '../../lib/api';
import { cn, errorMessage } from '../../lib/utils';
import { useApp } from '../../store';

type Updater<T> = (update: (draft: T) => void) => void;

/** Immutable update helper: clone, mutate the clone, return it. */
function produce<T>(value: T, update: (draft: T) => void): T {
  const next = structuredClone(value);
  update(next);
  return next;
}

function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-muted-foreground">
      {children}
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  maxLength = 200,
  className,
}: {
  label: string;
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label>{label}</Label>
      <Input
        value={value ?? ''}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
    </div>
  );
}

/** Comma-separated list. Keeps the raw text while typing so commas don't jump. */
function ListField({
  label,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState(items.join(', '));
  const parsed = (text: string) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  // Show what the user typed while it still parses to `items`; after an outside
  // change (discard, removing an entry above), show the list itself.
  const display = parsed(raw).join('\u0000') === items.join('\u0000') ? raw : items.join(', ');
  return (
    <div>
      <Label>{label}</Label>
      <Input
        value={display}
        placeholder={placeholder ?? 'Separate with commas'}
        aria-label={label}
        onChange={(e) => {
          setRaw(e.target.value);
          onChange(parsed(e.target.value));
        }}
      />
    </div>
  );
}

function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:text-destructive"
    >
      <Trash2 aria-hidden />
    </Button>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} className="text-primary">
      <Plus aria-hidden /> {children}
    </Button>
  );
}

/** Statements with their evidence. Editing a statement marks it as the user's. */
function PointList({
  label,
  points,
  onChange,
}: {
  label: string;
  points: ProfilePoint[];
  onChange: (points: ProfilePoint[]) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <ul className="space-y-2">
        {points.map((p, i) => (
          <li
            key={i}
            className={cn(
              'flex items-start gap-2 rounded-lg',
              p.status === 'unverified' && 'bg-warning/8 p-1.5 ring-1 ring-warning/30',
            )}
          >
            <Textarea
              rows={1}
              value={p.text}
              maxLength={600}
              aria-label={`${label} ${i + 1}`}
              onChange={(e) =>
                onChange(
                  produce(
                    points,
                    (d) => void (d[i] = { ...d[i]!, text: e.target.value, status: 'user' }),
                  ),
                )
              }
            />
            <div className="flex shrink-0 items-center gap-1 pt-1.5">
              <EvidenceBadge status={p.status} quote={p.quote} />
              <RemoveButton
                label="Remove"
                onClick={() => onChange(points.filter((_, j) => j !== i))}
              />
            </div>
          </li>
        ))}
      </ul>
      <AddButton onClick={() => onChange([...points, { text: '', quote: null, status: 'user' }])}>
        Add
      </AddButton>
    </div>
  );
}

function Section({
  title,
  description,
  onAdd,
  addLabel,
  children,
}: {
  title: string;
  description?: string;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        action={onAdd && <AddButton onClick={onAdd}>{addLabel ?? 'Add'}</AddButton>}
      />
      <CardBody className="space-y-4">{children}</CardBody>
    </Card>
  );
}

function Entry({
  children,
  onRemove,
  removeLabel,
}: {
  children: ReactNode;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="relative rounded-lg border border-border p-4 pr-12">
      <div className="absolute top-3 right-3">
        <RemoveButton label={removeLabel} onClick={onRemove} />
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

/** Remount with `key={detail.current.id}` so a new version replaces the draft. */
export function ProfileEditor({
  detail,
  onSaved,
}: {
  detail: ProfileDetail;
  onSaved: (detail: ProfileDetail) => void;
}) {
  const toast = useApp((s) => s.toast);
  const original = detail.current.data;
  const [draft, setDraft] = useState<CandidateProfile>(original);
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(original),
    [draft, original],
  );
  const unverified = countUnverified(draft);
  const update: Updater<CandidateProfile> = (fn) => setDraft((d) => produce(d, fn));

  const save = async () => {
    setSaving(true);
    try {
      const next = await invoke('profiles:saveVersion', { id: detail.id, data: draft });
      onSaved(next);
      toast('success', `Saved as version ${next.current.version}.`);
    } catch (err) {
      toast('error', `Couldn't save: ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5 pb-20" data-testid="profile-editor">
      {detail.document?.textQuality === 'none' && (
        <Banner>
          This PDF has no text layer (it may be scanned), so statements couldn't be checked against
          it automatically. Review them carefully.
        </Banner>
      )}
      {unverified > 0 && (
        <Banner testId="unverified-banner">
          {unverified === 1 ? '1 statement wasn’t' : `${unverified} statements weren’t`} found in
          your resume. They're highlighted below. Fix or delete them so answers never claim
          something you didn't do.
        </Banner>
      )}

      <Section title="Basics">
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Name"
            value={draft.name}
            maxLength={120}
            onChange={(v) => update((d) => void (d.name = v))}
          />
          <TextField
            label="Headline"
            value={draft.headline}
            onChange={(v) => update((d) => void (d.headline = v))}
          />
          <TextField
            label="Location"
            value={draft.location}
            maxLength={120}
            onChange={(v) => update((d) => void (d.location = v || null))}
          />
          <div>
            <Label>Years of experience</Label>
            <Input
              type="number"
              min={0}
              max={70}
              value={draft.totalYearsExperience ?? ''}
              aria-label="Years of experience"
              onChange={(e) =>
                update(
                  (d) =>
                    void (d.totalYearsExperience =
                      e.target.value === ''
                        ? null
                        : Math.max(0, Math.min(70, Math.round(Number(e.target.value))))),
                )
              }
            />
          </div>
        </div>
        <div>
          <Label>Summary</Label>
          <Textarea
            value={draft.summary}
            maxLength={2000}
            aria-label="Summary"
            onChange={(e) => update((d) => void (d.summary = e.target.value))}
          />
        </div>
      </Section>

      <Section
        title="Experience"
        onAdd={() =>
          update(
            (d) =>
              void d.experience.unshift({
                company: '',
                title: '',
                location: null,
                start: null,
                end: null,
                current: false,
                summary: '',
                highlights: [],
                technologies: [],
              }),
          )
        }
        addLabel="Add role"
      >
        {draft.experience.length === 0 && (
          <p className="text-sm text-muted-foreground">No roles.</p>
        )}
        {draft.experience.map((role, i) => (
          <Entry
            key={i}
            removeLabel={`Remove ${role.title || 'role'}`}
            onRemove={() => update((d) => void d.experience.splice(i, 1))}
          >
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Title"
                value={role.title}
                onChange={(v) => update((d) => void (d.experience[i]!.title = v))}
              />
              <TextField
                label="Company"
                value={role.company}
                onChange={(v) => update((d) => void (d.experience[i]!.company = v))}
              />
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label="Start"
                  placeholder="YYYY-MM"
                  maxLength={20}
                  value={role.start}
                  onChange={(v) => update((d) => void (d.experience[i]!.start = v || null))}
                />
                {role.current ? (
                  <div>
                    <Label>End</Label>
                    <p className="flex h-9 items-center text-sm text-muted-foreground">Present</p>
                  </div>
                ) : (
                  <TextField
                    label="End"
                    placeholder="YYYY-MM"
                    maxLength={20}
                    value={role.end}
                    onChange={(v) => update((d) => void (d.experience[i]!.end = v || null))}
                  />
                )}
              </div>
              <div className="flex items-end gap-4">
                <label className="flex h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={role.current}
                    className="size-4 accent-[var(--primary)]"
                    onChange={(e) =>
                      update((d) => {
                        d.experience[i]!.current = e.target.checked;
                        if (e.target.checked) d.experience[i]!.end = null;
                      })
                    }
                  />
                  Current role
                </label>
              </div>
            </div>
            {role.summary || role.highlights.length === 0 ? (
              <div>
                <Label>Description</Label>
                <Textarea
                  value={role.summary}
                  maxLength={1200}
                  aria-label="Role description"
                  onChange={(e) => update((d) => void (d.experience[i]!.summary = e.target.value))}
                />
              </div>
            ) : null}
            <PointList
              label="Highlights"
              points={role.highlights}
              onChange={(pts) => update((d) => void (d.experience[i]!.highlights = pts))}
            />
            <ListField
              label="Technologies"
              items={role.technologies}
              onChange={(items) => update((d) => void (d.experience[i]!.technologies = items))}
            />
          </Entry>
        ))}
      </Section>

      <Section
        title="Projects"
        onAdd={() =>
          update(
            (d) =>
              void d.projects.push({
                name: '',
                context: null,
                description: '',
                highlights: [],
                technologies: [],
              }),
          )
        }
        addLabel="Add project"
      >
        {draft.projects.length === 0 && (
          <p className="text-sm text-muted-foreground">No projects.</p>
        )}
        {draft.projects.map((project, i) => (
          <Entry
            key={i}
            removeLabel={`Remove ${project.name || 'project'}`}
            onRemove={() => update((d) => void d.projects.splice(i, 1))}
          >
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Name"
                value={project.name}
                onChange={(v) => update((d) => void (d.projects[i]!.name = v))}
              />
              <TextField
                label="Context"
                placeholder="e.g. open source, internal"
                value={project.context}
                onChange={(v) => update((d) => void (d.projects[i]!.context = v || null))}
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                value={project.description}
                maxLength={1200}
                aria-label="Project description"
                onChange={(e) => update((d) => void (d.projects[i]!.description = e.target.value))}
              />
            </div>
            {project.highlights.length > 0 && (
              <PointList
                label="Highlights"
                points={project.highlights}
                onChange={(pts) => update((d) => void (d.projects[i]!.highlights = pts))}
              />
            )}
            <ListField
              label="Technologies"
              items={project.technologies}
              onChange={(items) => update((d) => void (d.projects[i]!.technologies = items))}
            />
          </Entry>
        ))}
      </Section>

      <Section
        title="Skills"
        onAdd={() => update((d) => void d.skills.push({ category: '', items: [] }))}
        addLabel="Add group"
      >
        {draft.skills.map((group, i) => (
          <div key={i} className="flex items-end gap-3">
            <TextField
              className="w-48 shrink-0"
              label="Group"
              value={group.category}
              maxLength={100}
              onChange={(v) => update((d) => void (d.skills[i]!.category = v))}
            />
            <div className="min-w-0 flex-1">
              <ListField
                label="Skills"
                items={group.items}
                onChange={(items) => update((d) => void (d.skills[i]!.items = items))}
              />
            </div>
            <RemoveButton
              label={`Remove ${group.category || 'group'}`}
              onClick={() => update((d) => void d.skills.splice(i, 1))}
            />
          </div>
        ))}
      </Section>

      <Section
        title="Education"
        onAdd={() =>
          update(
            (d) =>
              void d.education.push({
                institution: '',
                degree: null,
                field: null,
                start: null,
                end: null,
                details: null,
              }),
          )
        }
      >
        {draft.education.map((ed, i) => (
          <Entry
            key={i}
            removeLabel={`Remove ${ed.institution || 'education'}`}
            onRemove={() => update((d) => void d.education.splice(i, 1))}
          >
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="School"
                value={ed.institution}
                onChange={(v) => update((d) => void (d.education[i]!.institution = v))}
              />
              <TextField
                label="Degree"
                value={ed.degree}
                onChange={(v) => update((d) => void (d.education[i]!.degree = v || null))}
              />
              <TextField
                label="Field"
                value={ed.field}
                onChange={(v) => update((d) => void (d.education[i]!.field = v || null))}
              />
              <TextField
                label="Year"
                placeholder="YYYY"
                maxLength={20}
                value={ed.end}
                onChange={(v) => update((d) => void (d.education[i]!.end = v || null))}
              />
            </div>
          </Entry>
        ))}
      </Section>

      <Section
        title="Certifications"
        onAdd={() =>
          update((d) => void d.certifications.push({ name: '', issuer: null, year: null }))
        }
      >
        {draft.certifications.map((c, i) => (
          <div key={i} className="flex items-end gap-3">
            <TextField
              className="flex-1"
              label="Certification"
              value={c.name}
              onChange={(v) => update((d) => void (d.certifications[i]!.name = v))}
            />
            <TextField
              className="w-28"
              label="Year"
              maxLength={20}
              value={c.year}
              onChange={(v) => update((d) => void (d.certifications[i]!.year = v || null))}
            />
            <RemoveButton
              label="Remove certification"
              onClick={() => update((d) => void d.certifications.splice(i, 1))}
            />
          </div>
        ))}
      </Section>

      <Section title="Achievements" description="Awards, talks, publications, or standout results.">
        <PointList
          label="Achievements"
          points={draft.achievements}
          onChange={(pts) => update((d) => void (d.achievements = pts))}
        />
      </Section>

      <Section
        title="Strengths"
        description="How a recruiter would read your resume. These guide answers but aren't quoted as facts."
        onAdd={() =>
          update((d) => void d.strengths.push({ text: '', evidence: '', status: 'user' }))
        }
      >
        {draft.strengths.map((s, i) => (
          <div key={i} className="flex items-start gap-3">
            <div className="grid min-w-0 flex-1 grid-cols-[1fr_1.4fr] gap-3">
              <TextField
                label="Strength"
                value={s.text}
                maxLength={300}
                onChange={(v) =>
                  update(
                    (d) => void (d.strengths[i] = { ...d.strengths[i]!, text: v, status: 'user' }),
                  )
                }
              />
              <TextField
                label="Evidence"
                value={s.evidence}
                maxLength={800}
                onChange={(v) =>
                  update(
                    (d) =>
                      void (d.strengths[i] = { ...d.strengths[i]!, evidence: v, status: 'user' }),
                  )
                }
              />
            </div>
            <div className="flex items-center gap-1 pt-6">
              <EvidenceBadge status={s.status} />
              <RemoveButton
                label="Remove strength"
                onClick={() => update((d) => void d.strengths.splice(i, 1))}
              />
            </div>
          </div>
        ))}
      </Section>

      <Section title="Spoken languages">
        <ListField
          label="Languages"
          items={draft.languages}
          placeholder="e.g. English, Spanish"
          onChange={(items) => update((d) => void (d.languages = items))}
        />
      </Section>

      {dirty && (
        <div
          className="sticky bottom-4 z-10 flex items-center gap-3 rounded-xl border border-border bg-card px-5 py-3 shadow-lg"
          data-testid="save-bar"
        >
          <p className="flex-1 text-sm">You have unsaved changes.</p>
          <Button variant="ghost" onClick={() => setDraft(original)} disabled={saving}>
            Discard
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

function Banner({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      className="flex gap-3 rounded-xl border border-warning/40 bg-warning/8 px-4 py-3 text-sm"
      role="note"
      data-testid={testId}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <p>{children}</p>
    </div>
  );
}
