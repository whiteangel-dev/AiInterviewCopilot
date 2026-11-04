import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvents, JobProgress } from '@aic/ipc';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from './engine';

const KEY = 'AIza-unit-test-key-000000000wxyz';
const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, '../../../../packages/core/fixtures', name)));

const dirs: string[] = [];
const stops: (() => unknown)[] = [];
let jobSeq = 0;
const jobId = () => `job-${++jobSeq}-xxxxxxxx`;

async function setup({ withKey = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aic-p2-'));
  dirs.push(dir);
  const progress: JobProgress[] = [];
  const engine = createEngine({
    emit: (event: keyof EngineEvents, data: unknown) => {
      if (event === 'job.progress') progress.push(data as JobProgress);
    },
    exit: () => undefined,
    logToConsole: false,
    today: () => '2026-11-03',
  });
  const h = engine.handlers;
  await h.init({
    dbPath: join(dir, 'app.db'),
    dbKeyHex: randomBytes(32).toString('hex'),
    backupDir: join(dir, 'bk'),
    logDir: join(dir, 'logs'),
    appVersion: 'test',
    fakeProvider: true,
    nativeAudioPath: null,
    audioReplay: null,
  });
  stops.push(() => h.shutdown());
  if (withKey)
    await h['apiKey.activate']({ provider: 'gemini', key: KEY, verification: null, models: null });
  return { h, progress };
}

afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('profiles', () => {
  it('imports a PDF resume, verifies quotes, and compiles the brief', async () => {
    const { h, progress } = await setup();
    const id = jobId();
    const p = await h['profiles.import']({
      jobId: id,
      fileName: 'jordan.pdf',
      data: fixture('resume-jordan-rivera.pdf'),
      profileId: null,
    });
    expect(p.name).toBe('Jordan Rivera');
    expect(p.document).toMatchObject({ fileName: 'jordan.pdf', kind: 'pdf', textQuality: 'good' });
    expect(p.current).toMatchObject({ version: 1, origin: 'extracted' });
    const [quayside] = p.current.data.experience;
    // Real quotes are found in the PDF; the fake "award" quote is not.
    expect(quayside!.highlights.map((x) => x.status)).toEqual([
      'verified',
      'verified',
      'unverified',
    ]);
    expect(p.current.brief).toContain(
      'Senior Software Engineer, Platform — Quayside Logistics (Mar 2021 – present)',
    );
    expect(progress.filter((x) => x.jobId === id).map((x) => x.stage)).toEqual([
      'reading',
      'analyzing',
      'checking',
      'saving',
    ]);

    const list = await h['profiles.list']();
    expect(list).toMatchObject([
      { id: p.id, headline: 'Senior Backend Engineer', unverifiedCount: 1 },
    ]);
    expect((await h['profiles.resumeText']({ id: p.id }))?.text).toContain('Pinecrest Labs');
  });

  it('marks quotes unchecked for a scanned PDF', async () => {
    const { h } = await setup();
    const p = await h['profiles.import']({
      jobId: jobId(),
      fileName: 'scan.pdf',
      data: fixture('resume-scanned.pdf'),
      profileId: null,
    });
    expect(p.document?.textQuality).toBe('none');
    expect(p.current.data.experience[0]!.highlights.every((x) => x.status === 'unchecked')).toBe(
      true,
    );
  });

  it('edits, restores, reanalyzes, renames, and deletes', async () => {
    const { h } = await setup();
    const p = await h['profiles.import']({
      jobId: jobId(),
      fileName: 'cv.docx',
      data: fixture('resume-jordan-rivera.docx'),
      profileId: null,
    });
    const edited = await h['profiles.saveVersion']({
      id: p.id,
      data: { ...p.current.data, headline: 'Staff Engineer' },
    });
    expect(edited.current).toMatchObject({ version: 2, origin: 'edited' });
    expect(edited.current.brief).toContain('Staff Engineer');

    const restored = await h['profiles.restoreVersion']({ id: p.id, versionId: p.current.id });
    expect(restored.current).toMatchObject({ version: 3, origin: 'restored' });
    expect(restored.current.data.headline).toBe('Senior Backend Engineer');

    const again = await h['profiles.reanalyze']({ jobId: jobId(), id: p.id });
    expect(again.current).toMatchObject({ version: 4, origin: 'extracted' });
    expect(again.versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);

    expect((await h['profiles.rename']({ id: p.id, name: 'Backend roles' })).name).toBe(
      'Backend roles',
    );
    await h['profiles.delete']({ id: p.id });
    expect(await h['profiles.list']()).toEqual([]);
    await expect(async () => h['profiles.get']({ id: p.id })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('needs a key, rejects bad files, and creates nothing on failure', async () => {
    const { h } = await setup({ withKey: false });
    await expect(
      h['profiles.import']({
        jobId: jobId(),
        fileName: 'a.pdf',
        data: fixture('resume-jordan-rivera.pdf'),
        profileId: null,
      }),
    ).rejects.toMatchObject({ code: 'no_api_key' });
    await h['apiKey.activate']({ provider: 'gemini', key: KEY, verification: null, models: null });
    await expect(
      h['profiles.import']({
        jobId: jobId(),
        fileName: 'notes.txt',
        data: new TextEncoder().encode('hi'),
        profileId: null,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_file' });
    expect(await h['profiles.list']()).toEqual([]);
  });

  it('cancels a running import', async () => {
    const { h } = await setup();
    const id = jobId();
    const running = h['profiles.import']({
      jobId: id,
      fileName: 'a.pdf',
      data: fixture('resume-jordan-rivera.pdf'),
      profileId: null,
    });
    await new Promise((r) => setTimeout(r, 10));
    await h['jobs.cancel']({ jobId: id });
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    expect(await h['profiles.list']()).toEqual([]);
  });
});

describe('knowledge', () => {
  it('manages items, analyzes them, and tracks staleness', async () => {
    const { h } = await setup();
    const base = await h['knowledge.createBase']({ name: 'Kestrel Pay', description: '' });
    const items = await h['knowledge.addItems']({
      baseId: base.id,
      items: [
        {
          kind: 'fact',
          category: 'compensation',
          title: 'Salary',
          content: 'Target base $185k–$205k.',
        },
        {
          kind: 'fact',
          category: 'compensation',
          title: 'Pay',
          content: 'Target base $185k-$205k',
        },
        {
          kind: 'instruction',
          category: 'style',
          title: 'Tone',
          content: 'Sound calm and confident.',
        },
      ],
    });
    const analysis = await h['knowledge.analyze']({
      jobId: jobId(),
      baseId: base.id,
      profileId: null,
    });
    expect(analysis.issues).toEqual([
      expect.objectContaining({ type: 'duplicate', itemIds: [items[0]!.id, items[1]!.id] }),
    ]);
    expect(analysis.stale).toBe(false);

    await h['knowledge.deleteItem']({ id: items[1]!.id });
    const detail = await h['knowledge.getBase']({ id: base.id });
    expect(detail.items).toHaveLength(2);
    expect(detail.analysis?.stale).toBe(true);
    expect(detail.analysis?.issues[0]?.itemIds).toEqual([items[0]!.id]);
    expect((await h['knowledge.listBases']())[0]).toMatchObject({
      name: 'Kestrel Pay',
      itemCount: 2,
    });
  });

  it('splits free-form notes into proposed items without saving them', async () => {
    const { h } = await setup();
    const proposals = await h['knowledge.splitNotes']({
      jobId: jobId(),
      text: '## Notes\n- Never mention the 2020 layoffs.\n- My target salary is $195k.\n\nI led the Black Friday incident response.',
    });
    expect(proposals).toEqual([
      expect.objectContaining({ kind: 'instruction', content: 'Never mention the 2020 layoffs.' }),
      expect.objectContaining({ kind: 'fact', category: 'compensation' }),
      expect.objectContaining({
        kind: 'fact',
        content: 'I led the Black Friday incident response.',
      }),
    ]);
    expect(await h['knowledge.listBases']()).toEqual([]);
  });

  it('previews the combined context', async () => {
    const { h } = await setup();
    const p = await h['profiles.import']({
      jobId: jobId(),
      fileName: 'cv.pdf',
      data: fixture('resume-jordan-rivera.pdf'),
      profileId: null,
    });
    const base = await h['knowledge.createBase']({ name: 'B', description: '' });
    await h['knowledge.addItems']({
      baseId: base.id,
      items: [{ kind: 'instruction', category: 'style', title: '', content: 'Be brief.' }],
    });
    const preview = await h['context.preview']({ profileId: p.id, baseId: base.id });
    expect(preview.text).toContain("Today's date: 2026-11-03");
    expect(preview.text).toContain('Quayside Logistics');
    expect(preview.text).toContain('- Be brief.');
  });
});

describe('answer bank', () => {
  it('generates drafts once, skips duplicates, and matches questions', async () => {
    const { h } = await setup();
    const p = await h['profiles.import']({
      jobId: jobId(),
      fileName: 'cv.pdf',
      data: fixture('resume-jordan-rivera.pdf'),
      profileId: null,
    });
    const first = await h['answers.generate']({ jobId: jobId(), profileId: p.id, baseId: null });
    expect(first).toHaveLength(3);
    expect(first.every((a) => a.status === 'draft' && a.origin === 'generated')).toBe(true);

    const second = await h['answers.generate']({ jobId: jobId(), profileId: p.id, baseId: null });
    expect(second).toHaveLength(3); // the fake returns the same questions: all duplicates

    const intro = first.find((a) => a.category === 'intro')!;
    const approved = await h['answers.update']({
      id: intro.id,
      fields: { ...intro, status: 'approved' },
    });
    expect(approved.status).toBe('approved');
    const manual = await h['answers.add']({
      profileId: p.id,
      fields: {
        question: 'Why Kafka?',
        variants: [],
        category: 'technical',
        answer: 'Replay.',
        status: 'approved',
      },
    });
    expect(manual.origin).toBe('manual');

    const [match] = await h['answers.match']({
      profileId: p.id,
      question: 'Could you walk me through your background?',
    });
    expect(match).toMatchObject({
      answer: { id: intro.id },
      matchedText: 'Walk me through your background.',
    });
    expect(match!.score).toBeGreaterThanOrEqual(0.6);

    await h['answers.delete']({ id: manual.id });
    expect(await h['answers.list']({ profileId: p.id })).toHaveLength(3);
  });
});
