import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_MODELS } from '@aic/core';
import type { EngineEvents, EngineInitParams } from '@aic/ipc';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from './engine';

const VALID = 'AIza-unit-test-key-000000000wxyz';
const dirs: string[] = [];
const shutdowns: (() => unknown)[] = [];

async function setup(
  dir = mkdtempSync(join(tmpdir(), 'aic-engine-')),
  keyHex = randomBytes(32).toString('hex'),
) {
  dirs.push(dir);
  const events: { event: keyof EngineEvents; data: unknown }[] = [];
  const engine = createEngine({
    emit: (event, data) => events.push({ event, data }),
    exit: () => undefined,
    logToConsole: false,
  });
  const params: EngineInitParams = {
    dbPath: join(dir, 'data', 'app.db'),
    dbKeyHex: keyHex,
    backupDir: join(dir, 'data', 'backups'),
    logDir: join(dir, 'logs'),
    appVersion: '0.0.0-test',
    fakeProvider: true,
  };
  const h = engine.handlers;
  await h.init(params);
  shutdowns.push(() => h.shutdown());
  return { h, events, dir, keyHex };
}

afterEach(async () => {
  for (const s of shutdowns.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('engine', () => {
  it('refuses calls before init', async () => {
    const engine = createEngine({
      emit: () => undefined,
      exit: () => undefined,
      logToConsole: false,
    });
    await expect(async () => engine.handlers['settings.get']()).rejects.toMatchObject({
      code: 'engine_unavailable',
    });
  });

  it('updates settings, persists them, and emits only on change', async () => {
    const { h, events, dir, keyHex } = await setup();
    await h['settings.update']({ appearance: { theme: 'dark' } });
    await h['settings.update']({ appearance: { theme: 'dark' } });
    expect(events.filter((e) => e.event === 'settings.changed')).toHaveLength(1);
    await h.shutdown();
    shutdowns.length = 0;

    const reopened = await setup(dir, keyHex);
    expect((await reopened.h['settings.get']()).appearance.theme).toBe('dark');
  });

  it('verify does not store anything; activate does', async () => {
    const { h } = await setup();
    const result = await h['apiKey.verify']({ provider: 'gemini', key: VALID });
    expect(result.verification.outcome).toBe('valid');
    expect((await h['apiKey.status']({ provider: 'gemini' })).configured).toBe(false);

    const status = await h['apiKey.activate']({ provider: 'gemini', key: VALID, ...result });
    expect(status).toMatchObject({ configured: true, hint: 'wxyz', verification: 'valid' });

    const catalog = await h['models.list']({ provider: 'gemini', refresh: false });
    expect(catalog.models).toHaveLength(FAKE_MODELS.length);
    expect(catalog.recommended.answerFast).toBe('gemini-3.5-flash-lite');
  });

  it('keeps the stored verification when the same key is reloaded at startup', async () => {
    const { h, dir, keyHex } = await setup();
    const result = await h['apiKey.verify']({ provider: 'gemini', key: VALID });
    await h['apiKey.activate']({ provider: 'gemini', key: VALID, ...result });
    await h.shutdown();
    shutdowns.length = 0;

    const reopened = await setup(dir, keyHex);
    expect((await reopened.h['apiKey.status']({ provider: 'gemini' })).configured).toBe(false);
    const status = await reopened.h['apiKey.activate']({
      provider: 'gemini',
      key: VALID,
      verification: null,
      models: null,
    });
    expect(status).toMatchObject({ configured: true, verification: 'valid', hint: 'wxyz' });
  });

  it('marks a key invalid when the provider starts rejecting it', async () => {
    const { h, events } = await setup();
    const revoked = 'AIza-INVALID-but-was-saved-0000';
    await h['apiKey.activate']({
      provider: 'gemini',
      key: revoked,
      verification: null,
      models: null,
    });
    const status = await h['apiKey.recheck']({ provider: 'gemini' });
    expect(status.verification).toBe('invalid');
    expect(events.at(-1)).toMatchObject({ event: 'apiKey.changed' });
    await expect(h['models.list']({ provider: 'gemini', refresh: true })).rejects.toMatchObject({
      code: 'invalid_api_key',
    });
  });

  it('requires a key for models and clears it', async () => {
    const { h } = await setup();
    await expect(h['models.list']({ provider: 'gemini', refresh: false })).rejects.toMatchObject({
      code: 'no_api_key',
    });
    await h['apiKey.activate']({
      provider: 'gemini',
      key: VALID,
      verification: null,
      models: null,
    });
    expect(await h['apiKey.clear']({ provider: 'gemini' })).toMatchObject({
      configured: false,
      hint: null,
    });
  });
});
