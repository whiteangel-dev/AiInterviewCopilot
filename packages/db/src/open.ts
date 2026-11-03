// The ambient typing must be referenced so consumers that compile this file see it.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./better-sqlite3-multiple-ciphers.d.ts" />
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '@aic/ipc';
import Database from 'better-sqlite3-multiple-ciphers';
import type BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MIGRATIONS, runMigrations, schemaVersion, type Migration } from './migrations';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

export interface AppDatabase {
  sqlite: BetterSqlite3.Database;
  db: Db;
  schemaVersion: number;
  /** Set when an existing database was backed up before migrating. */
  backupPath: string | null;
  close(): void;
}

export interface OpenDatabaseOptions {
  path: string;
  /** 32-byte key as 64 hex characters. */
  keyHex: string;
  /** Where to copy the database before migrating it. Omit to skip backups (tests). */
  backupDir?: string;
  keepBackups?: number;
  migrations?: readonly Migration[];
}

const KEY_HEX = /^[0-9a-f]{64}$/i;
const BACKUP_FILE = /^app-v\d+-\d{8}T\d{6}Z?-?\d*\.db$/;

/** The on-disk cipher. ChaCha20-Poly1305 (sqleet), SQLite3MultipleCiphers' default. */
export const DB_CIPHER = 'chacha20';

/**
 * Opens (or creates) the encrypted database, applies pending migrations, and backs
 * up an existing database first. Throws `db_unlock_failed` if the key is wrong.
 */
export function openDatabase(options: OpenDatabaseOptions): AppDatabase {
  const { path, keyHex, backupDir, keepBackups = 3, migrations = MIGRATIONS } = options;
  if (!KEY_HEX.test(keyHex)) throw new AppError('internal', 'Invalid database key format.');

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existed = existsSync(path) && statSync(path).size > 0;
  const sqlite = new Database(path);

  try {
    sqlite.pragma(`cipher = '${DB_CIPHER}'`);
    sqlite.pragma(`hexkey = '${keyHex}'`);
    try {
      sqlite.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_NOTADB') {
        throw new AppError(
          'db_unlock_failed',
          "Your local data can't be unlocked on this device. It may have been copied from another computer or Windows account.",
          { cause: err },
        );
      }
      throw err;
    }

    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');

    const from = schemaVersion(sqlite);
    let backupPath: string | null = null;
    if (existed && backupDir && from > 0 && from < migrations.length) {
      backupPath = backupDatabase(sqlite, path, backupDir, from, keepBackups);
    }
    const version = runMigrations(sqlite, migrations);

    return {
      sqlite,
      db: drizzle({ client: sqlite, schema }),
      schemaVersion: version,
      backupPath,
      close: () => {
        if (sqlite.open) sqlite.close();
      },
    };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

/**
 * Copies the database file after a full checkpoint. The copy stays encrypted with
 * the same key. Keeps the newest `keep` backups.
 */
function backupDatabase(
  sqlite: BetterSqlite3.Database,
  path: string,
  backupDir: string,
  version: number,
  keep: number,
): string {
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  let dest = join(backupDir, `app-v${version}-${stamp}.db`);
  for (let n = 1; existsSync(dest); n++) dest = join(backupDir, `app-v${version}-${stamp}-${n}.db`);
  copyFileSync(path, dest);

  const backups = readdirSync(backupDir)
    .filter((name) => BACKUP_FILE.test(name))
    .map((name) => ({ name, mtime: statSync(join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  for (const old of backups.slice(keep)) rmSync(join(backupDir, old.name), { force: true });
  return dest;
}
