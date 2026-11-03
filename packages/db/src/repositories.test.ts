import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_PROFILE } from '@aic/ipc';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from './migrations';
import { openDatabase, type AppDatabase } from './open';
import { AnswerRepository } from './repositories/answers';
import { KnowledgeRepository } from './repositories/knowledge';
import { ProfileRepository } from './repositories/profiles';

const dirs: string[] = [];
const dbs: AppDatabase[] = [];

function open(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'aic-repo-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'app.db'), keyHex: randomBytes(32).toString('hex') });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const version = (name: string) => ({
  origin: 'extracted' as const,
  documentId: null,
  data: { ...EMPTY_PROFILE, name },
  brief: name,
  model: 'm',
  promptVersion: 'p@1',
  durationMs: 1,
  inputTokens: 1,
  outputTokens: 1,
});

describe('ProfileRepository', () => {
  it('numbers versions per profile and keeps documents', () => {
    const r = new ProfileRepository(open().db);
    const a = r.create('A');
    const b = r.create('B');
    expect(r.addVersion(a.id, version('a1')).version).toBe(1);
    expect(r.addVersion(a.id, version('a2')).version).toBe(2);
    expect(r.addVersion(b.id, version('b1')).version).toBe(1);
    expect(r.latestVersion(a.id)?.data.name).toBe('a2');
    expect(r.versions(a.id).map((v) => v.version)).toEqual([2, 1]);

    const doc = r.addDocument(a.id, {
      fileName: 'cv.pdf',
      kind: 'pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
      sha256: 'x',
      content: Buffer.from([1, 2, 3]),
      text: 'hello',
      pageCount: 1,
      textQuality: 'good',
    });
    expect(doc).not.toHaveProperty('content');
    expect(r.document(doc.id)?.content).toEqual(Buffer.from([1, 2, 3]));
    expect(r.latestDocument(a.id)?.fileName).toBe('cv.pdf');
  });

  it('deleting a profile removes its versions, documents and answers', () => {
    const db = open();
    const profiles = new ProfileRepository(db.db);
    const answers = new AnswerRepository(db.db);
    const p = profiles.create('P');
    profiles.addVersion(p.id, version('v'));
    answers.add(p.id, [
      {
        question: 'Q?',
        variants: [],
        category: 'intro',
        answer: 'A',
        status: 'draft',
        origin: 'manual',
        model: null,
      },
    ]);
    expect(profiles.delete(p.id)).toBe(true);
    expect(profiles.latestVersion(p.id)).toBeUndefined();
    expect(answers.list(p.id)).toEqual([]);
  });
});

describe('KnowledgeRepository', () => {
  it('counts items, keeps order, and keeps only the latest analysis', () => {
    const r = new KnowledgeRepository(open().db);
    const base = r.createBase('Kestrel Pay', 'Ledger role');
    const items = r.addItems(base.id, [
      { kind: 'fact', category: 'experience', title: 'One', content: '1' },
      { kind: 'instruction', category: 'style', title: 'Two', content: '2' },
    ]);
    expect(r.listBases()).toMatchObject([{ id: base.id, itemCount: 2 }]);
    expect(r.items(base.id).map((i) => i.title)).toEqual(['One', 'Two']);

    r.updateItem(items[0]!.id, {
      kind: 'fact',
      category: 'project',
      title: 'One',
      content: 'changed',
    });
    expect(r.item(items[0]!.id)?.content).toBe('changed');
    expect(r.deleteItem(items[1]!.id)).toBe(true);
    expect(r.deleteItem(items[1]!.id)).toBe(false);

    const result = { summary: 's', issues: [], reclassify: [] };
    r.saveAnalysis({
      baseId: base.id,
      profileId: null,
      itemsHash: 'h1',
      result,
      model: 'm',
      promptVersion: 'p',
    });
    const second = r.saveAnalysis({
      baseId: base.id,
      profileId: null,
      itemsHash: 'h2',
      result,
      model: 'm',
      promptVersion: 'p',
    });
    expect(r.latestAnalysis(base.id)?.id).toBe(second.id);

    expect(r.deleteBase(base.id)).toBe(true);
    expect(r.items(base.id)).toEqual([]);
    expect(r.latestAnalysis(base.id)).toBeUndefined();
  });
});

describe('migrations', () => {
  it('upgrades a Phase 1 database without losing settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aic-mig-'));
    dirs.push(dir);
    const opts = {
      path: join(dir, 'app.db'),
      keyHex: randomBytes(32).toString('hex'),
      backupDir: join(dir, 'bk'),
    };
    const v1 = openDatabase({ ...opts, migrations: MIGRATIONS.slice(0, 1) });
    v1.sqlite
      .prepare('INSERT INTO app_settings VALUES (\'appearance\', \'{"theme":"dark"}\', 1)')
      .run();
    v1.close();

    const latest = openDatabase(opts);
    dbs.push(latest);
    expect(latest.schemaVersion).toBe(MIGRATIONS.length);
    expect(latest.backupPath).toMatch(/app-v1-/);
    expect(latest.sqlite.prepare('SELECT value FROM app_settings').get()).toEqual({
      value: '{"theme":"dark"}',
    });
  });
});
