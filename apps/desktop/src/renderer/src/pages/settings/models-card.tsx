import type { ModelCatalog, ModelRole, ModelRoles } from '@aic/ipc';
import { DEFAULT_MODELS, MODEL_ROLES, MODEL_ROLE_KIND } from '@aic/ipc/models';
import { Cpu, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardBody, CardHeader, Field } from '../../components/ui/card';
import { Select, type SelectOption } from '../../components/ui/select';
import { invoke } from '../../lib/api';
import { errorMessage, timeAgo } from '../../lib/utils';
import { useApp } from '../../store';

const ROLE_TEXT: Record<ModelRole, { label: string; description: string }> = {
  transcription: {
    label: 'Transcription',
    description: "Turns the interviewer's speech into text as they talk.",
  },
  turnAnalyzer: {
    label: 'Question detection',
    description: 'Decides when the interviewer has finished a question.',
  },
  answerFast: {
    label: 'Answers: Fast',
    description: 'Writes live answers. About half a second to the first words.',
  },
  answerQuality: {
    label: 'Answers: Quality',
    description: 'Used in Quality mode. Stronger, but about 5 seconds to the first words.',
  },
  preparation: {
    label: 'Preparation',
    description: 'Reads your resume and notes before the interview.',
  },
};

export function ModelsCard() {
  const settings = useApp((s) => s.settings);
  const apiKey = useApp((s) => s.apiKey);
  const updateSettings = useApp((s) => s.updateSettings);
  const [fetched, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usable = !!apiKey?.configured && apiKey.verification !== 'invalid';

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await invoke('models:list', { provider: 'gemini', refresh }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load the cached list when a usable key appears (or changes); ignore stale replies.
  useEffect(() => {
    if (!usable) return;
    let current = true;
    invoke('models:list', { provider: 'gemini', refresh: false }).then(
      (result) => current && setCatalog(result),
      (err: unknown) => current && setError(errorMessage(err)),
    );
    return () => {
      current = false;
    };
  }, [usable, apiKey?.hint]);

  if (!settings) return null;
  // A catalog fetched with a key that has since been removed or rejected is not shown.
  const catalog = usable ? fetched : null;
  const models = settings.models;
  const recommended = catalog?.recommended ?? {};
  const differsFromRecommended = MODEL_ROLES.some(
    (role) => recommended[role] && recommended[role] !== models[role],
  );

  const optionsFor = (role: ModelRole): SelectOption[] => {
    const ids = (catalog?.models ?? [])
      .filter((m) => m.kind === MODEL_ROLE_KIND[role])
      .map((m) => m.id);
    if (!ids.includes(models[role])) ids.unshift(models[role]);
    return ids.map((id) => ({
      value: id,
      label: id,
      hint:
        id === recommended[role]
          ? 'Recommended'
          : catalog && !catalog.models.some((m) => m.id === id)
            ? 'Unavailable'
            : undefined,
    }));
  };

  const useRecommended = () => {
    const patch: Partial<ModelRoles> = {};
    for (const role of MODEL_ROLES) {
      const id = recommended[role];
      if (id && id !== models[role]) patch[role] = id;
    }
    void updateSettings({ models: patch });
  };

  return (
    <Card id="models" data-testid="models-card">
      <CardHeader
        icon={<Cpu />}
        title="Models"
        description={
          catalog
            ? `${catalog.models.length} models available to your key · updated ${timeAgo(catalog.fetchedAt)}`
            : 'Which Gemini model does each job.'
        }
        action={
          usable && (
            <div className="flex gap-2">
              {differsFromRecommended && (
                <Button variant="secondary" size="sm" onClick={useRecommended}>
                  Use recommended
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void load(true)}
                loading={loading}
                aria-label="Refresh model list"
                title="Refresh model list"
              >
                {!loading && <RefreshCw aria-hidden />}
              </Button>
            </div>
          )
        }
      />
      <CardBody>
        {error && (
          <p
            className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}
        {MODEL_ROLES.map((role) => {
          const unavailable = catalog && !catalog.models.some((m) => m.id === models[role]);
          return (
            <Field
              key={role}
              label={
                <span className="flex items-center gap-2">
                  {ROLE_TEXT[role].label}
                  {unavailable && <Badge tone="warning">Unavailable</Badge>}
                </span>
              }
              description={ROLE_TEXT[role].description}
              htmlFor={`model-${role}`}
            >
              <Select
                id={`model-${role}`}
                value={models[role]}
                options={optionsFor(role)}
                onChange={(id) => void updateSettings({ models: { [role]: id } })}
                disabled={!usable || !catalog}
                aria-label={ROLE_TEXT[role].label}
              />
            </Field>
          );
        })}
        {!usable && (
          <p className="mt-4 text-[13px] text-muted-foreground">
            Add your API key to choose models. Until then the recommended defaults are used (
            {DEFAULT_MODELS.answerFast} for live answers).
          </p>
        )}
      </CardBody>
    </Card>
  );
}
