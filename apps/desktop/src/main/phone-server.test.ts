import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@aic/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhoneServer, newPhoneToken, type PhoneCommands } from './phone-server';

const log = createLogger({ console: false, scope: 'test' });
const servers: PhoneServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function renderer() {
  const dir = mkdtempSync(join(tmpdir(), 'aic-phone-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'phone.html'), '<!doctype html><title>Phone</title>');
  writeFileSync(join(dir, 'index.html'), 'MAIN WINDOW');
  writeFileSync(join(dir, 'assets', 'phone-abc.js'), 'console.log(1)');
  return dir;
}

async function start(commands: Partial<PhoneCommands> = {}) {
  const token = newPhoneToken();
  const clients: number[] = [];
  const server = new PhoneServer(token, {
    rendererRoot: renderer(),
    host: '127.0.0.1',
    ports: [0],
    log,
    onClients: (n) => clients.push(n),
    commands: {
      snapshot: () => Promise.resolve({ state: null, transcript: null, answers: [] }),
      answerNow: () => Promise.resolve(),
      regenerate: () => Promise.resolve(),
      ...commands,
    },
  });
  servers.push(server);
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  return { server, token, base, clients };
}

describe('PhoneServer', () => {
  it('serves the phone page only with the pairing token, then by cookie', async () => {
    const { server, token, base } = await start();
    expect(server.urls()).toEqual([`${base}/?k=${token}`]);

    const denied = await fetch(`${base}/`);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toMatch(/Scan the QR code/);
    expect((await fetch(`${base}/?k=wrong-token`)).status).toBe(403);

    const page = await fetch(`${base}/?k=${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const cookie = page.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly; SameSite=Strict/);

    const asset = await fetch(`${base}/assets/phone-abc.js`, {
      headers: { cookie: cookie.split(';')[0]! },
    });
    expect(asset.status).toBe(200);
    // Nothing outside the phone page and its assets.
    const other = await fetch(`${base}/index.html`, { headers: { cookie: cookie.split(';')[0]! } });
    expect(other.status).toBe(404);
    const escape = await fetch(`${base}/assets/..%2Findex.html`, {
      headers: { cookie: cookie.split(';')[0]! },
    });
    expect(escape.status).toBe(404);
  });

  it('streams a snapshot, then live events, to every phone', async () => {
    const { server, token, base, clients } = await start({
      snapshot: () => Promise.resolve({ state: null, transcript: null, answers: [] }),
    });
    const received: string[] = [];
    const req = request(`${base}/api/events?k=${token}`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => received.push(chunk));
    });
    req.end();
    await vi.waitFor(() => expect(received.join('')).toContain('event: snapshot'));
    expect(server.clients).toBe(1);
    server.broadcast('live:answer', { id: 'a1', text: 'Sure.' });
    await vi.waitFor(() => expect(received.join('')).toContain('event: live:answer'));
    expect(received.join('')).toContain('"text":"Sure."');

    // A new token disconnects paired phones.
    server.setToken(newPhoneToken());
    await vi.waitFor(() => expect(server.clients).toBe(0));
    expect(clients).toContain(1);
    req.destroy();
  });

  it('runs Answer now and Regenerate from the phone, but only with its header', async () => {
    const answerNow = vi.fn(() => Promise.resolve());
    const regenerate = vi.fn(() => Promise.resolve());
    const { token, base } = await start({ answerNow, regenerate });
    const post = (body: unknown, headers: Record<string, string> = { 'x-aic-phone': '1' }) =>
      fetch(`${base}/api/command?k=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect((await post({ action: 'answerNow' }, {})).status).toBe(403);
    expect((await post({ action: 'answerNow' })).status).toBe(200);
    expect(answerNow).toHaveBeenCalledOnce();
    expect((await post({ action: 'regenerate', answerId: 'a1', length: 'short' })).status).toBe(
      200,
    );
    expect(regenerate).toHaveBeenCalledWith('a1', 'short');
    expect((await post({ action: 'deleteEverything' })).status).toBe(400);
  });

  it('reports why a command failed', async () => {
    const { token, base } = await start({
      answerNow: () => Promise.reject(new Error('Start an interview first.')),
    });
    const res = await fetch(`${base}/api/command?k=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aic-phone': '1' },
      body: '{"action":"answerNow"}',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, message: 'Start an interview first.' });
  });
});
