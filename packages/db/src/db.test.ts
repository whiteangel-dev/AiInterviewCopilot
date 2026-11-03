import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@aic/ipc';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, type Migration } from './migrations';
import { openDatabase, type AppDatabase } from './open';
import { ProviderConfigRepository } from './repositories/provider-configs';
import { SettingsRepository } from './repositories/settings';

const dirs: string[] = [];
const open: AppDatabase[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aic-db-'));
  dirs.push(dir);
  return {
    path: join(dir, 'db', 'app.db'),
    backupDir: join(dir, 'db', 'backups'),
    keyHex: randomBytes(32).toString('hex'),
  };
}

function track(db: AppDatabase): AppDatabase {
  open.push(db);
  return db;
}

const m = (version: number, sql: string): Migration => ({
  version,
  tag: `test_${version}`,
  statements: [sql],
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates an encrypted database at the latest schema', () => {
    const opts = setup();
    const db = track(openDatabase(opts));
    expect(db.schemaVersion).toBe(MIGRATIONS.length);
    expect(db.backupPath).toBeNull();
    new SettingsRepository(db.db).save({ ...DEFAULT_SETTINGS, appearance: { theme: 'dark' } }, [
      'appearance',
    ]);
    db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    db.close();

    const bytes = readFileSync(opts.path);
    expect(bytes.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');
    expect(bytes.includes('app_settings')).toBe(false);
    expect(bytes.includes('"theme"')).toBe(false);
  });

  it('refuses the wrong key with db_unlock_failed', () => {
    const opts = setup();
    track(openDatabase(opts)).close();
    expect(() => openDatabase({ ...opts, keyHex: randomBytes(32).toString('hex') })).toThrow(
      expect.objectContaining({ code: 'db_unlock_failed' }),
    );
  });

  it('rejects malformed keys', () => {
    expect(() => openDatabase({ ...setup(), keyHex: 'abc' })).toThrow(/key format/);
  });

  it('backs up an existing database before migrating it, and the backup stays encrypted', () => {
    const opts = setup();
    const v1 = [m(1, 'CREATE TABLE notes (body TEXT)')];
    const first = track(openDatabase({ ...opts, migrations: v1 }));
    first.sqlite.prepare('INSERT INTO notes VALUES (?)').run('kept');
    first.close();

    const v2 = [...v1, m(2, 'ALTER TABLE notes ADD COLUMN created_at INTEGER')];
    const second = track(openDatabase({ ...opts, migrations: v2 }));
    expect(second.schemaVersion).toBe(2);
    expect(second.backupPath).toMatch(/app-v1-.*\.db$/);
    second.close();

    const backup = track(
      openDatabase({ path: second.backupPath!, keyHex: opts.keyHex, migrations: v1 }),
    );
    expect(backup.schemaVersion).toBe(1);
    expect(backup.sqlite.prepare('SELECT body FROM notes').get()).toEqual({ body: 'kept' });
    expect(readFileSync(second.backupPath!).includes('kept')).toBe(false);
  });

  it('keeps only the newest backups', () => {
    const opts = setup();
    const migrations: Migration[] = [];
    for (let v = 1; v <= 5; v++) {
      migrations.push(m(v, `CREATE TABLE t${v} (x)`));
      track(openDatabase({ ...opts, migrations, keepBackups: 2 })).close();
    }
    expect(readdirSync(opts.backupDir).sort()).toEqual([
      expect.stringMatching(/^app-v3-/),
      expect.stringMatching(/^app-v4-/),
    ]);
  });

  it('rolls back a failed migration and leaves the version unchanged', () => {
    const opts = setup();
    const v1 = [m(1, 'CREATE TABLE a (x)')];
    track(openDatabase({ ...opts, migrations: v1 })).close();
    const broken: Migration = {
      version: 2,
      tag: 'broken',
      statements: ['CREATE TABLE b (x)', 'THIS IS NOT SQL'],
    };
    expect(() => openDatabase({ ...opts, migrations: [...v1, broken] })).toThrow();
    const db = track(openDatabase({ ...opts, migrations: v1 }));
    expect(db.schemaVersion).toBe(1);
    expect(
      db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='b'").get(),
    ).toBeUndefined();
  });

  it('refuses a database written by a newer app version', () => {
    const opts = setup();
    track(
      openDatabase({
        ...opts,
        migrations: [m(1, 'CREATE TABLE a (x)'), m(2, 'CREATE TABLE b (x)')],
      }),
    ).close();
    expect(() => openDatabase({ ...opts, migrations: [m(1, 'CREATE TABLE a (x)')] })).toThrow(
      expect.objectContaining({ code: 'db_newer_than_app' }),
    );
  });
});

describe('repositories', () => {
  it('settings round-trip by section', () => {
    const db = track(openDatabase(setup()));
    const repo = new SettingsRepository(db.db);
    expect(repo.load()).toEqual(DEFAULT_SETTINGS);
    const changed = {
      ...DEFAULT_SETTINGS,
      answers: { mode: 'quality' as const, length: 'short' as const },
      appearance: { theme: 'light' as const },
    };
    repo.save(changed, ['answers']);
    expect(repo.load()).toEqual({ ...DEFAULT_SETTINGS, answers: changed.answers });
  });

  it('provider configs: set key, verify, cache models, clear', () => {
    const db = track(openDatabase(setup()));
    const repo = new ProviderConfigRepository(db.db);
    expect(repo.get('gemini')).toBeUndefined();

    const models = [
      {
        id: 'gemini-3.5-flash-lite',
        displayName: 'Flash-Lite',
        kind: 'text' as const,
        inputTokenLimit: 1,
        outputTokenLimit: 2,
      },
    ];
    const saved = repo.setKey(
      'gemini',
      { ref: 'apikey.gemini', hint: 'wxyz' },
      { outcome: 'valid', message: null, checkedAt: 1000 },
      models,
    );
    expect(saved).toMatchObject({
      keyHint: 'wxyz',
      verification: 'valid',
      checkedAt: 1000,
      modelCatalog: models,
      modelsFetchedAt: 1000,
    });

    repo.recordVerification('gemini', { outcome: 'invalid', message: 'revoked', checkedAt: 2000 });
    expect(repo.get('gemini')).toMatchObject({
      id: saved.id,
      verification: 'invalid',
      verificationMessage: 'revoked',
      modelCatalog: models,
    });

    expect(repo.clearKey('gemini')).toMatchObject({
      id: saved.id,
      keyRef: null,
      keyHint: null,
      verification: 'unverified',
      modelCatalog: null,
    });
  });
});
