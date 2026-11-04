import type { Logger } from '@aic/core';
import { AppError, type UpdateStatus } from '@aic/ipc';

/** The part of electron-updater's autoUpdater used here (injectable for tests). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: () => void): unknown;
  on(event: 'download-progress', listener: (p: { percent: number }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdatesOptions {
  /** null when updates are off (development builds, tests), with the reason. */
  updater: UpdaterLike | null;
  disabledReason?: string;
  /** True while an interview or audio test runs: never restart then. */
  busy(): boolean;
  onStatus(status: UpdateStatus): void;
  log: Logger;
  /** First check after start, then every `intervalMs`. */
  firstCheckMs?: number;
  intervalMs?: number;
}

/**
 * Automatic updates from GitHub Releases. Updates download in the background;
 * the app offers "Restart to update", and otherwise installs the update the
 * next time it quits. It never restarts by itself, and refuses to while an
 * interview is running.
 */
export class Updates {
  #status: UpdateStatus;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly o: UpdatesOptions) {
    this.#status = o.updater
      ? { state: 'idle', checkedAt: null }
      : { state: 'disabled', reason: o.disabledReason ?? 'Updates are off in this build.' };
    const u = o.updater;
    if (!u) return;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.on('checking-for-update', () => this.#set({ state: 'checking' }));
    u.on('update-available', (info) => {
      o.log.info('update available', { version: info.version });
      this.#set({ state: 'downloading', version: info.version, percent: 0 });
    });
    u.on('download-progress', (p) => {
      if (this.#status.state === 'downloading') {
        this.#set({ ...this.#status, percent: Math.round(p.percent) });
      }
    });
    u.on('update-downloaded', (info) => {
      o.log.info('update downloaded', { version: info.version });
      this.#set({ state: 'ready', version: info.version });
    });
    u.on('update-not-available', () => this.#set({ state: 'idle', checkedAt: Date.now() }));
    u.on('error', (err) => {
      o.log.warn('update check failed', { err: err.message });
      // A downloaded update stays ready even if a later check fails.
      if (this.#status.state !== 'ready') {
        this.#set({ state: 'error', message: friendly(err.message) });
      }
    });
  }

  get status(): UpdateStatus {
    return { ...this.#status };
  }

  start(): void {
    if (!this.o.updater) return;
    const first = setTimeout(() => void this.check(), this.o.firstCheckMs ?? 15_000);
    const every = setInterval(() => void this.check(), this.o.intervalMs ?? 4 * 60 * 60 * 1000);
    first.unref?.();
    every.unref?.();
    this.#timers.push(first, every);
  }

  stop(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
  }

  async check(): Promise<UpdateStatus> {
    const u = this.o.updater;
    if (!u || this.#status.state === 'ready' || this.#status.state === 'downloading') {
      return this.status;
    }
    try {
      await u.checkForUpdates();
    } catch (err) {
      // Also reported through the 'error' event; keep the status consistent.
      if (this.#status.state === 'checking') {
        this.#set({ state: 'error', message: friendly((err as Error).message) });
      }
    }
    return this.status;
  }

  /** Restarts into the downloaded update. */
  install(): void {
    if (this.#status.state !== 'ready' || !this.o.updater) {
      throw new AppError('invalid_input', 'No update is ready to install.');
    }
    if (this.o.busy()) {
      throw new AppError(
        'invalid_input',
        'End the interview first. The update also installs the next time you quit the app.',
      );
    }
    this.o.log.info('restarting to install the update', { version: this.#status.version });
    this.o.updater.quitAndInstall(true, true);
  }

  #set(status: UpdateStatus) {
    this.#status = status;
    this.o.onStatus(this.status);
  }
}

function friendly(message: string): string {
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|net::/i.test(message)) {
    return "Couldn't reach GitHub to check for updates.";
  }
  if (/404|no published versions|latest\.yml/i.test(message)) {
    return 'No published release yet.';
  }
  return "Couldn't check for updates.";
}
