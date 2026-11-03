import { KNOWLEDGE_CATEGORIES, type KnowledgeItemFields } from '@aic/ipc';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Segmented } from '../../components/ui/segmented';
import { Select } from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { CATEGORY_LABELS } from './labels';

export function ItemEditor({
  initial,
  onSave,
  onCancel,
  saveLabel = 'Save',
}: {
  initial: KnowledgeItemFields;
  onSave: (fields: KnowledgeItemFields) => Promise<void>;
  onCancel: () => void;
  saveLabel?: string;
}) {
  const [fields, setFields] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<KnowledgeItemFields>) => setFields((f) => ({ ...f, ...patch }));

  return (
    <form
      className="space-y-3 rounded-xl border border-ring/40 bg-card p-4 shadow-sm"
      data-testid="item-editor"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onSave({
          ...fields,
          title: fields.title.trim(),
          content: fields.content.trim(),
        }).finally(() => setBusy(false));
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Kind"
          value={fields.kind}
          options={[
            { value: 'fact', label: 'Fact' },
            { value: 'instruction', label: 'Instruction' },
          ]}
          onChange={(kind) => set({ kind })}
        />
        <Select
          className="w-52"
          aria-label="Category"
          value={fields.category}
          options={KNOWLEDGE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          onChange={(category) => set({ category: category as KnowledgeItemFields['category'] })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {fields.kind === 'fact'
          ? 'Something true about you that answers can use.'
          : 'How answers should be written, or what to say or avoid.'}
      </p>
      <Input
        placeholder="Title (optional)"
        value={fields.title}
        maxLength={120}
        onChange={(e) => set({ title: e.target.value })}
        aria-label="Title"
      />
      <Textarea
        placeholder={
          fields.kind === 'fact'
            ? 'e.g. I led the 2022 Black Friday incident response: consumer lag hit 2 hours; we rolled back and…'
            : 'e.g. If asked about salary, ask for their range first. If pushed, say around 195 base.'
        }
        rows={4}
        value={fields.content}
        maxLength={6000}
        onChange={(e) => set({ content: e.target.value })}
        aria-label="Content"
        autoFocus
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!fields.content.trim()}>
          {saveLabel}
        </Button>
      </div>
    </form>
  );
}
