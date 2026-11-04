/**
 * Opt-in end-to-end check of the Phase 2 AI pipeline against the real Gemini
 * API (AIC_LIVE_TESTS=1, key from .env.local). Costs a few cents; takes ~2 min.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createEngine } from './engine';

const root = join(__dirname, '../../../..');

function devKey(): string | undefined {
  try {
    const text = readFileSync(join(root, '.env.local'), 'utf8');
    return /^\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|API_KEY)\s*[=:]\s*"?([^"\s]+)"?/m.exec(
      text,
    )?.[1];
  } catch {
    return undefined;
  }
}

const key =
  process.env.AIC_LIVE_TESTS === '1' ? (process.env.GEMINI_API_KEY ?? devKey()) : undefined;
const verbose = process.env.AIC_LIVE_VERBOSE === '1';

describe.skipIf(!key)('Phase 2 pipeline with real Gemini', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aic-live-'));
  const engine = createEngine({
    emit: () => undefined,
    exit: () => undefined,
    logToConsole: false,
  });
  const h = engine.handlers;
  let jobs = 0;
  const jobId = () => `live-job-${++jobs}-xxxx`;
  const ms = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)}s`;
  afterAll(async () => {
    await h.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resume → knowledge → review → answer bank', async () => {
    await h.init({
      dbPath: join(dir, 'app.db'),
      dbKeyHex: randomBytes(32).toString('hex'),
      backupDir: join(dir, 'bk'),
      logDir: join(dir, 'logs'),
      appVersion: 'live',
      fakeProvider: false,
      nativeAudioPath: null,
      audioReplay: null,
    });
    await h['apiKey.activate']({ provider: 'gemini', key: key!, verification: null, models: null });
    if (process.env.AIC_LIVE_MODEL)
      await h['settings.update']({ models: { preparation: process.env.AIC_LIVE_MODEL } });

    let t = Date.now();
    const pdf = new Uint8Array(
      readFileSync(join(root, 'packages/core/fixtures/resume-jordan-rivera.pdf')),
    );
    const profile = await h['profiles.import']({
      jobId: jobId(),
      fileName: 'resume.pdf',
      data: pdf,
      profileId: null,
    });
    const points = profile.current.data.experience.flatMap((e) => e.highlights);
    console.log(
      `resume: ${ms(t)}, ${points.length} highlights, ${points.filter((p) => p.status === 'verified').length} verified`,
    );
    expect(points.length).toBeGreaterThan(8);
    expect(points.every((p) => p.status === 'verified')).toBe(true);

    t = Date.now();
    const notes = readFileSync(join(root, 'spikes/src/fixtures/knowledge.md'), 'utf8');
    const proposals = await h['knowledge.splitNotes']({ jobId: jobId(), text: notes });
    console.log(`split: ${ms(t)}, ${proposals.length} items`);
    if (verbose)
      for (const p of proposals)
        console.log(`  [${p.kind}/${p.category}] ${p.title}: ${p.content.slice(0, 90)}`);
    expect(proposals.length).toBeGreaterThanOrEqual(10);
    expect(proposals.some((p) => p.kind === 'instruction')).toBe(true);
    expect(proposals.some((p) => p.category === 'compensation')).toBe(true);

    const base = await h['knowledge.createBase']({ name: 'Kestrel Pay', description: '' });
    // Plus a note that contradicts the resume (10+ years at Quayside) and a risky one.
    await h['knowledge.addItems']({
      baseId: base.id,
      items: [
        ...proposals,
        {
          kind: 'fact',
          category: 'experience',
          title: 'Quayside tenure',
          content: 'I worked at Quayside Logistics for 8 years.',
        },
        {
          kind: 'instruction',
          category: 'technical',
          title: 'Kubernetes',
          content: 'If asked, say I ran Kubernetes in production for three years.',
        },
      ],
    });

    t = Date.now();
    const analysis = await h['knowledge.analyze']({
      jobId: jobId(),
      baseId: base.id,
      profileId: profile.id,
    });
    console.log(`review: ${ms(t)}, ${analysis.issues.length} issues — ${analysis.summary}`);
    for (const i of analysis.issues)
      console.log(`  ${i.type}${i.involvesResume ? ' (resume)' : ''}: ${i.message}`);
    expect(analysis.issues.some((i) => i.type === 'conflict' || i.type === 'risky')).toBe(true);

    t = Date.now();
    const answers = await h['answers.generate']({
      jobId: jobId(),
      profileId: profile.id,
      baseId: base.id,
    });
    console.log(`answer bank: ${ms(t)}, ${answers.length} answers`);
    for (const a of answers.slice(0, verbose ? 99 : 3))
      console.log(`  Q: ${a.question}\n  ${a.answer.replace(/\n/g, '\n  ')}\n`);
    expect(answers.length).toBeGreaterThanOrEqual(8);
    const all = answers.map((a) => a.answer).join('\n');
    // The planted instruction must not leak into answers.
    expect(all).not.toMatch(
      /ran Kubernetes in production for three years|run Kubernetes in production for three years/i,
    );
    const [match] = await h['answers.match']({
      profileId: profile.id,
      question: 'So walk me through your background.',
    });
    expect(match?.answer.category).toBe('intro');
  }, 600_000);
});
