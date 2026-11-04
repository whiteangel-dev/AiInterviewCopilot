import type { KeyOrigin, KeyVerification, ModelInfo, ProviderId } from '@aic/ipc';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../open';
import { providerConfigs, type ProviderConfigRow } from '../schema';

type Patch = Partial<Omit<ProviderConfigRow, 'id' | 'provider' | 'createdAt' | 'updatedAt'>>;

export class ProviderConfigRepository {
  constructor(private readonly db: Db) {}

  get(provider: ProviderId): ProviderConfigRow | undefined {
    return this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.provider, provider))
      .get();
  }

  #upsert(provider: ProviderId, patch: Patch): ProviderConfigRow {
    const now = Date.now();
    return this.db
      .insert(providerConfigs)
      .values({ id: uuidv7(), provider, ...patch, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: providerConfigs.provider, set: { ...patch, updatedAt: now } })
      .returning()
      .get();
  }

  /** Records a newly saved key. The cached model list is replaced (or cleared) with it. */
  setKey(
    provider: ProviderId,
    key: { ref: string; hint: string },
    verification: KeyVerification | null,
    models: ModelInfo[] | null,
    origin: KeyOrigin = { source: 'typed', label: null, expiresAt: null },
  ): ProviderConfigRow {
    return this.#upsert(provider, {
      keyRef: key.ref,
      keyHint: key.hint,
      keySource: origin.source,
      keyLabel: origin.label,
      keyExpiresAt: origin.expiresAt,
      verification: verification?.outcome ?? 'unverified',
      verificationMessage: verification?.message ?? null,
      checkedAt: verification?.checkedAt ?? null,
      modelCatalog: models,
      modelsFetchedAt: models ? (verification?.checkedAt ?? Date.now()) : null,
    });
  }

  recordVerification(provider: ProviderId, verification: KeyVerification): ProviderConfigRow {
    return this.#upsert(provider, {
      verification: verification.outcome,
      verificationMessage: verification.message,
      checkedAt: verification.checkedAt,
    });
  }

  saveModels(provider: ProviderId, models: ModelInfo[], fetchedAt: number): ProviderConfigRow {
    return this.#upsert(provider, { modelCatalog: models, modelsFetchedAt: fetchedAt });
  }

  clearKey(provider: ProviderId): ProviderConfigRow {
    return this.#upsert(provider, {
      keyRef: null,
      keyHint: null,
      keySource: 'typed',
      keyLabel: null,
      keyExpiresAt: null,
      verification: 'unverified',
      verificationMessage: null,
      checkedAt: null,
      modelCatalog: null,
      modelsFetchedAt: null,
    });
  }
}
