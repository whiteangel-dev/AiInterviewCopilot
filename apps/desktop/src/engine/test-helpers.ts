/** Shared setup for the engine's integration tests (recorded audio, offline fakes). */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav, tone } from '@aic/core';
import type { EngineEvents, EngineInitParams } from '@aic/ipc';
import { createEngine } from './engine';

export const KEY = 'AIza-unit-test-key-000000000wxyz';
export const dirs: string[] = [];
export const stops: (() => unknown)[] = [];

/** Silence and tone bursts ("speech") at 16 kHz, as a WAV file. */
export function speechWav(
  dir: string,
  name: string,
  pattern: [silenceMs: number, speechMs: number][],
) {
  const parts: Int16Array[] = [];
  for (const [silence, speech] of pattern) {
    parts.push(new Int16Array(16 * silence), tone(speech, 300, -20));
  }
  parts.push(new Int16Array(16 * 2000));
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const file = join(dir, name);
  writeFileSync(file, encodeWav(all));
  return file;
}

export async function setup(
  replay: { interviewer: string | null; candidate: string | null } | null,
  /** Reopen an earlier engine's data (a restart). */
  reuse?: EngineInitParams,
) {
  const dir = mkdtempSync(join(tmpdir(), 'aic-p3-'));
  dirs.push(dir);
  const events: { event: keyof EngineEvents; data: unknown }[] = [];
  const engine = createEngine({
    emit: (event, data) => events.push({ event, data }),
    exit: () => undefined,
    logToConsole: false,
    today: () => '2026-11-04',
  });
  const h = engine.handlers;
  const init: EngineInitParams = reuse ?? {
    dbPath: join(dir, 'app.db'),
    dbKeyHex: randomBytes(32).toString('hex'),
    backupDir: join(dir, 'bk'),
    logDir: join(dir, 'logs'),
    appVersion: 'test',
    fakeProvider: true,
    nativeAudioPath: null,
    audioReplay: replay,
  };
  await h.init(init);
  stops.push(() => h.shutdown());
  await h['apiKey.activate']({ provider: 'gemini', key: KEY, verification: null, models: null });
  const of = <K extends keyof EngineEvents>(event: K) =>
    events.filter((e) => e.event === event).map((e) => e.data as EngineEvents[K]);
  return { h, dir, init, of, engine };
}

/** Handlers may throw synchronously; the RPC layer turns that into a rejection. */
export const call = async <T>(fn: () => T | Promise<T>): Promise<T> => fn();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => T | undefined | false, timeoutMs = 8000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}

export async function cleanup(): Promise<void> {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
