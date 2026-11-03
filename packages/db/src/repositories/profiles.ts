import { and, desc, eq, max } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Db } from '../open';
import {
  profiles,
  profileVersions,
  resumeDocuments,
  type ProfileRow,
  type ProfileVersionRow,
  type ResumeDocumentRow,
} from '../schema';

export type DocumentMeta = Omit<ResumeDocumentRow, 'content' | 'text'>;
export type NewDocument = Omit<ResumeDocumentRow, 'id' | 'profileId' | 'createdAt'>;
export type NewVersion = Omit<ProfileVersionRow, 'id' | 'profileId' | 'version' | 'createdAt'>;

const documentMeta = {
  id: resumeDocuments.id,
  profileId: resumeDocuments.profileId,
  fileName: resumeDocuments.fileName,
  kind: resumeDocuments.kind,
  mimeType: resumeDocuments.mimeType,
  sizeBytes: resumeDocuments.sizeBytes,
  sha256: resumeDocuments.sha256,
  pageCount: resumeDocuments.pageCount,
  textQuality: resumeDocuments.textQuality,
  createdAt: resumeDocuments.createdAt,
};

export class ProfileRepository {
  constructor(private readonly db: Db) {}

  list(): ProfileRow[] {
    return this.db.select().from(profiles).orderBy(desc(profiles.updatedAt)).all();
  }

  get(id: string): ProfileRow | undefined {
    return this.db.select().from(profiles).where(eq(profiles.id, id)).get();
  }

  create(name: string): ProfileRow {
    const now = Date.now();
    return this.db
      .insert(profiles)
      .values({ id: uuidv7(), name, createdAt: now, updatedAt: now })
      .returning()
      .get();
  }

  rename(id: string, name: string): void {
    this.db.update(profiles).set({ name, updatedAt: Date.now() }).where(eq(profiles.id, id)).run();
  }

  /** Deletes the profile with its documents, versions and prepared answers. */
  delete(id: string): boolean {
    return this.db.delete(profiles).where(eq(profiles.id, id)).run().changes > 0;
  }

  addDocument(profileId: string, doc: NewDocument): DocumentMeta {
    return this.db
      .insert(resumeDocuments)
      .values({ ...doc, id: uuidv7(), profileId, createdAt: Date.now() })
      .returning(documentMeta)
      .get();
  }

  latestDocument(profileId: string): DocumentMeta | undefined {
    return this.db
      .select(documentMeta)
      .from(resumeDocuments)
      .where(eq(resumeDocuments.profileId, profileId))
      .orderBy(desc(resumeDocuments.createdAt), desc(resumeDocuments.id))
      .get();
  }

  document(id: string): ResumeDocumentRow | undefined {
    return this.db.select().from(resumeDocuments).where(eq(resumeDocuments.id, id)).get();
  }

  /** Appends a version (version numbers are per profile, starting at 1). */
  addVersion(profileId: string, version: NewVersion): ProfileVersionRow {
    return this.db.transaction((tx) => {
      const current =
        tx
          .select({ v: max(profileVersions.version) })
          .from(profileVersions)
          .where(eq(profileVersions.profileId, profileId))
          .get()?.v ?? 0;
      const now = Date.now();
      const row = tx
        .insert(profileVersions)
        .values({ ...version, id: uuidv7(), profileId, version: current + 1, createdAt: now })
        .returning()
        .get();
      tx.update(profiles).set({ updatedAt: now }).where(eq(profiles.id, profileId)).run();
      return row;
    });
  }

  latestVersion(profileId: string): ProfileVersionRow | undefined {
    return this.db
      .select()
      .from(profileVersions)
      .where(eq(profileVersions.profileId, profileId))
      .orderBy(desc(profileVersions.version))
      .get();
  }

  version(profileId: string, versionId: string): ProfileVersionRow | undefined {
    return this.db
      .select()
      .from(profileVersions)
      .where(and(eq(profileVersions.profileId, profileId), eq(profileVersions.id, versionId)))
      .get();
  }

  versions(profileId: string): Omit<ProfileVersionRow, 'data' | 'brief'>[] {
    return this.db
      .select({
        id: profileVersions.id,
        profileId: profileVersions.profileId,
        version: profileVersions.version,
        origin: profileVersions.origin,
        documentId: profileVersions.documentId,
        model: profileVersions.model,
        promptVersion: profileVersions.promptVersion,
        durationMs: profileVersions.durationMs,
        inputTokens: profileVersions.inputTokens,
        outputTokens: profileVersions.outputTokens,
        createdAt: profileVersions.createdAt,
      })
      .from(profileVersions)
      .where(eq(profileVersions.profileId, profileId))
      .orderBy(desc(profileVersions.version))
      .all();
  }
}
