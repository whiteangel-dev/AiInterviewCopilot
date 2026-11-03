import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from './logger';

const fakeGoogleKey = ['AI', 'za', 'Sy', 'X'.repeat(33)].join('');
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aic-log-'));
  dirs.push(dir);
  return dir;
};

describe('logger', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('writes redacted JSON lines with scope and serialized errors', () => {
    const file = join(tempDir(), 'test.log');
    const log = createLogger({ file, level: 'info', console: false, scope: 'engine' });
    log.debug('hidden');
    log.child('db').info('opened', { key: fakeGoogleKey });
    log.error('failed', { err: new Error(`bad ${fakeGoogleKey}`) });
    log.close();

    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'info', scope: 'engine.db', key: '<redacted-key>' });
    expect(lines[1]?.err).toMatchObject({ name: 'Error', message: 'bad <redacted-key>' });
    expect(readFileSync(file, 'utf8')).not.toContain(fakeGoogleKey);
  });

  it('keeps data fields from overwriting the envelope', () => {
    const file = join(tempDir(), 'env.log');
    const log = createLogger({ file, console: false, scope: 'main' });
    log.warn('hello', { level: 'weak', msg: 'x', scope: 'y', t: 1 });
    log.close();
    const entry = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'warn',
      msg: 'hello',
      scope: 'main',
      'data.level': 'weak',
      'data.msg': 'x',
      'data.scope': 'y',
      'data.t': 1,
    });
  });

  it('rotates when the file grows too large', () => {
    const file = join(tempDir(), 'rot.log');
    const log = createLogger({ file, console: false, maxBytes: 300, maxFiles: 2 });
    for (let i = 0; i < 20; i++) log.info('line', { i, pad: 'x'.repeat(40) });
    log.close();
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    expect(readFileSync(file, 'utf8').length).toBeLessThanOrEqual(300);
  });
});
