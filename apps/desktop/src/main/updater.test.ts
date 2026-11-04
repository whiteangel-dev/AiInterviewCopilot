import { EventEmitter } from 'node:events';
import { createLogger } from '@aic/core';
import type { UpdateStatus } from '@aic/ipc';
import { describe, expect, it, vi } from 'vitest';
import { Updates, type UpdaterLike } from './updater';

const log = createLogger({ console: false, scope: 'test' });

function fakeUpdater() {
  const events = new EventEmitter();
  const checkForUpdates = vi.fn(() => {
    events.emit('checking-for-update');
    return Promise.resolve(null);
  });
  const quitAndInstall = vi.fn();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    checkForUpdates,
    quitAndInstall,
  } as unknown as UpdaterLike;
  const emit = (event: string, ...args: unknown[]) => events.emit(event, ...args);
  return { updater, checkForUpdates, quitAndInstall, emit };
}

describe('Updates', () => {
  it('downloads in the background and offers a restart, but not during an interview', async () => {
    const { updater: u, quitAndInstall, emit } = fakeUpdater();
    const seen: UpdateStatus[] = [];
    let busy = true;
    const updates = new Updates({
      updater: u,
      busy: () => busy,
      onStatus: (s) => seen.push(s),
      log,
    });
    expect(u.autoDownload).toBe(true);
    expect(u.autoInstallOnAppQuit).toBe(true);

    await updates.check();
    emit('update-available', { version: '1.1.0' });
    emit('download-progress', { percent: 42.4 });
    emit('update-downloaded', { version: '1.1.0' });
    expect(seen.map((s) => s.state)).toEqual(['checking', 'downloading', 'downloading', 'ready']);
    expect(seen[2]).toEqual({ state: 'downloading', version: '1.1.0', percent: 42 });
    expect(updates.status).toEqual({ state: 'ready', version: '1.1.0' });

    // Never restarts during an interview.
    expect(() => updates.install()).toThrow(/End the interview first/);
    expect(quitAndInstall).not.toHaveBeenCalled();
    busy = false;
    updates.install();
    expect(quitAndInstall).toHaveBeenCalledWith(true, true);

    // A failed later check doesn't hide the ready update.
    emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(updates.status.state).toBe('ready');
  });

  it('reports up to date, and explains failures plainly', async () => {
    const { updater: u, emit } = fakeUpdater();
    const updates = new Updates({ updater: u, busy: () => false, onStatus: () => undefined, log });
    await updates.check();
    emit('update-not-available');
    expect(updates.status).toMatchObject({ state: 'idle' });
    expect((updates.status as { checkedAt: number }).checkedAt).toBeGreaterThan(0);
    emit('error', new Error('getaddrinfo ENOTFOUND github.com'));
    expect(updates.status).toEqual({
      state: 'error',
      message: "Couldn't reach GitHub to check for updates.",
    });
    expect(() => updates.install()).toThrow(/No update is ready/);
  });

  it('is off in development builds', async () => {
    const updates = new Updates({
      updater: null,
      disabledReason: 'Updates are off in development builds.',
      busy: () => false,
      onStatus: () => undefined,
      log,
    });
    expect(await updates.check()).toEqual({
      state: 'disabled',
      reason: 'Updates are off in development builds.',
    });
  });

  it('checks shortly after start, then every few hours', () => {
    vi.useFakeTimers();
    const { updater: u, checkForUpdates, emit } = fakeUpdater();
    const updates = new Updates({
      updater: u,
      busy: () => false,
      onStatus: () => undefined,
      log,
      firstCheckMs: 1000,
      intervalMs: 60_000,
    });
    updates.start();
    vi.advanceTimersByTime(999);
    expect(checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    emit('update-not-available');
    vi.advanceTimersByTime(60_000);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    updates.stop();
    vi.useRealTimers();
  });
});
