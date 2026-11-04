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
import { SessionRepository } from './repositories/sessions';

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

describe('SessionRepository', () => {
  const audio = { backend: 'replay' as const, interviewer: 'Test', candidate: 'Test' };
  const newSession = (repo: SessionRepository, startedAt: number, profileId: string | null) =>
    repo.create({
      title: 'Interview',
      profileId,
      profileVersionId: null,
      profileName: 'Jordan',
      knowledgeBaseId: null,
      knowledgeBaseName: null,
      context: 'ctx',
      vocabulary: ['KestrelPay'],
      audio,
      startedAt,
    });

  it('stores segments in time order and lists sessions newest first with counts', () => {
    const db = open();
    const repo = new SessionRepository(db.db);
    const older = newSession(repo, 1000, null);
    const newer = newSession(repo, 2000, null);
    repo.addSegment(newer.id, { channel: 'candidate', text: 'Sure.', startMs: 3000, endMs: 3500 });
    repo.addSegment(newer.id, { channel: 'interviewer', text: 'Hi?', startMs: 100, endMs: 900 });
    expect(repo.segments(newer.id).map((s) => s.text)).toEqual(['Hi?', 'Sure.']);
    expect(repo.list().map((s) => [s.id, s.segmentCount])).toEqual([
      [newer.id, 2],
      [older.id, 0],
    ]);
    expect(repo.get(newer.id)?.vocabulary).toEqual(['KestrelPay']);
    repo.delete(newer.id);
    expect(repo.segmentCount(newer.id)).toBe(0);
  });

  it('marks sessions cut off by a crash as interrupted', () => {
    const db = open();
    const repo = new SessionRepository(db.db);
    const s = newSession(repo, 1000, null);
    repo.addSegment(s.id, { channel: 'interviewer', text: 'Hello', startMs: 0, endMs: 4200 });
    expect(repo.markInterrupted()).toBe(1);
    const after = repo.get(s.id)!;
    expect(after.status).toBe('interrupted');
    expect(after.durationMs).toBe(4200);
    expect(after.endedAt).not.toBeNull();
    expect(repo.markInterrupted()).toBe(0);
  });

  it('purges old finished sessions but never a live one', () => {
    const db = open();
    const repo = new SessionRepository(db.db);
    const old = newSession(repo, 1000, null);
    repo.update(old.id, { status: 'ended', endedAt: 2000 });
    const live = newSession(repo, 1500, null);
    const recent = newSession(repo, 10_000, null);
    repo.update(recent.id, { status: 'ended' });
    expect(repo.purgeStartedBefore(5000)).toBe(1);
    expect(
      repo
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual([live.id, recent.id].sort());
  });

  it('saves questions and answers, updates them in place, and deletes them with the session', () => {
    const db = open();
    const repo = new SessionRepository(db.db);
    const s = newSession(repo, 1000, null);
    repo.saveQuestion({
      id: 'q1',
      sessionId: s.id,
      heard: 'So tell me about yourself',
      question: 'So tell me about yourself',
      type: null,
      askedAtMs: 4200,
    });
    const answer = {
      id: 'a1',
      sessionId: s.id,
      questionId: 'q1',
      source: 'generated' as const,
      trigger: 'analyzer' as const,
      length: 'standard' as const,
      model: 'flash-lite',
      preparedAnswerId: null,
      promptVersion: 'live-answer@1',
      text: 'Sure.',
      status: 'streaming' as const,
      error: null,
      latencyMs: 950,
    };
    repo.saveAnswer(answer);
    // The analyzer's label and the finished answer arrive later.
    repo.saveQuestion({
      id: 'q1',
      sessionId: s.id,
      heard: 'So tell me about yourself',
      question: 'Tell me about yourself.',
      type: 'background',
      askedAtMs: 4200,
    });
    repo.saveAnswer({
      ...answer,
      text: "Sure. I'm a backend engineer.",
      status: 'done',
      outputTokens: 9,
    });
    repo.saveQuestion({
      id: 'q2',
      sessionId: s.id,
      heard: 'Right?',
      question: 'Right?',
      type: null,
      askedAtMs: 9000,
    });
    repo.saveAnswer({ ...answer, id: 'a2', questionId: 'q2', status: 'withdrawn' });

    const answers = repo.answers(s.id);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      id: 'a1',
      text: "Sure. I'm a backend engineer.",
      status: 'done',
      latencyMs: 950,
      outputTokens: 9,
      question: { question: 'Tell me about yourself.', type: 'background', askedAtMs: 4200 },
    });
    expect(repo.answers(s.id, { withdrawn: true })).toHaveLength(2);
    expect(repo.list()[0]!.answerCount).toBe(1);
    expect(repo.answerCount(s.id)).toBe(1);

    repo.saveAnswer({ ...answer, id: 'a3', status: 'streaming' });
    expect(repo.stopStreamingAnswers()).toBe(1);

    repo.delete(s.id);
    expect(repo.answers(s.id, { withdrawn: true })).toEqual([]);
  });

  it('keeps a session when its profile is deleted', () => {
    const db = open();
    const profiles = new ProfileRepository(db.db);
    const repo = new SessionRepository(db.db);
    const p = profiles.create('Jordan');
    const s = newSession(repo, 1000, p.id);
    profiles.delete(p.id);
    const after = repo.get(s.id)!;
    expect(after.profileId).toBeNull();
    expect(after.profileName).toBe('Jordan');
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
