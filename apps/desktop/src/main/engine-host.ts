import { EventEmitter } from 'node:events';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { Logger } from '@aic/core';
import {
  AppError,
  RpcClient,
  type CallOptions,
  type EngineEvents,
  type EngineInitParams,
  type EngineMethods,
  type EngineStatus,
  type ErrorCode,
  type RpcEndpoint,
} from '@aic/ipc';

type Client = RpcClient<EngineMethods, EngineEvents>;
type CallArgs<P> = [P] extends [void]
  ? [params?: undefined, options?: CallOptions]
  : [params: P, options?: CallOptions];

export interface EngineHostOptions {
  modulePath: string;
  /** Computed on every (re)start. A fatal AppError fails the start without retrying. */
  initParams(): Promise<EngineInitParams>;
  /** Runs after `init` and before the engine is marked ready (e.g. loading API keys). */
  onInitialized(client: Client): Promise<void>;
  env?: Record<string, string>;
  logger: Logger;
}

/** Errors a restart can't fix: stop and show them instead of looping. */
const FATAL_CODES: ReadonlySet<ErrorCode> = new Set([
  'db_unlock_failed',
  'db_newer_than_app',
  'secure_storage_unavailable',
]);
const RESTART_DELAYS_MS = [250, 1000, 2000, 5000, 10000];
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 5;
const READY_TIMEOUT_MS = 20_000;

/**
 * Runs the engine utility process: starts it, initializes it, restarts it with
 * backoff after crashes, and queues calls until it is ready.
 */
export class EngineHost {
  readonly events = new EventEmitter<{
    status: [EngineStatus];
    'settings.changed': [EngineEvents['settings.changed']];
    'apiKey.changed': [EngineEvents['apiKey.changed']];
  }>();

  #status: EngineStatus = { state: 'starting', error: null, restarts: 0, schemaVersion: null };
  #child: UtilityProcess | null = null;
  #client: Client | null = null;
  #waiters: { resolve(client: Client): void; reject(err: AppError): void }[] = [];
  #crashes: number[] = [];
  #stopping = false;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: EngineHostOptions) {}

  get status(): EngineStatus {
    return structuredClone(this.#status);
  }

  start(): void {
    this.#stopping = false;
    this.#spawn();
  }

  async call<K extends keyof EngineMethods>(
    method: K,
    ...args: CallArgs<EngineMethods[K]['params']>
  ): Promise<EngineMethods[K]['result']> {
    const client = await this.#whenReady();
    return client.call(method, ...args);
  }

  /** Stops the engine gracefully (closing the database), then kills it if needed. */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const child = this.#child;
    const client = this.#client;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      await client?.call('shutdown', undefined, { timeoutMs: 2000 });
    } catch {
      // not ready or already gone
    }
    const killed = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]);
    if (!killed) {
      child.kill();
      await exited;
    }
  }

  /** Stops and starts a fresh engine, clearing the crash history. */
  async restart(): Promise<void> {
    await this.stop();
    this.#crashes = [];
    this.#setStatus({ state: 'starting', error: null, schemaVersion: null });
    this.start();
  }

  #setStatus(patch: Partial<EngineStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.events.emit('status', this.status);
  }

  #whenReady(): Promise<Client> {
    if (this.#status.state === 'ready' && this.#client) return Promise.resolve(this.#client);
    if (this.#status.state === 'failed') {
      return Promise.reject(
        AppError.from(
          this.#status.error ?? {
            code: 'engine_unavailable',
            message: 'The engine is not running.',
          },
        ),
      );
    }
    return new Promise<Client>((resolve, reject) => {
      const waiter = {
        resolve: (client: Client) => {
          clearTimeout(timer);
          resolve(client);
        },
        reject: (err: AppError) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new AppError('engine_unavailable', 'The engine is taking too long to start.'));
      }, READY_TIMEOUT_MS);
      this.#waiters.push(waiter);
    });
  }

  #flushWaiters(result: { client: Client } | { error: AppError }): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) {
      if ('client' in result) w.resolve(result.client);
      else w.reject(result.error);
    }
  }

  #spawn(): void {
    const log = this.options.logger;
    const child = utilityProcess.fork(this.options.modulePath, [], {
      serviceName: 'AI Interview Copilot Engine',
      stdio: 'pipe',
      env: { ...process.env, ...this.options.env },
    });
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));

    const endpoint: RpcEndpoint = {
      postMessage: (message) => child.postMessage(message),
      onMessage: (listener) => {
        const handler = (message: unknown) => listener(message);
        child.on('message', handler);
        return () => child.off('message', handler);
      },
    };
    const client: Client = new RpcClient(endpoint, { timeoutMs: 15_000 });
    client.on('settings.changed', (s) => this.events.emit('settings.changed', s));
    client.on('apiKey.changed', (s) => this.events.emit('apiKey.changed', s));

    this.#child = child;
    this.#client = client;
    child.once('spawn', () => {
      log.info('engine spawned', { pid: child.pid });
      void this.#initialize(child, client);
    });
    child.once('exit', (code) => this.#onExit(child, client, code));
  }

  async #initialize(child: UtilityProcess, client: Client): Promise<void> {
    const log = this.options.logger;
    try {
      const params = await this.options.initParams();
      const result = await client.call('init', params, { timeoutMs: 30_000 });
      await this.options.onInitialized(client);
      if (this.#child !== child) return;
      this.#setStatus({ state: 'ready', error: null, schemaVersion: result.schemaVersion });
      if (result.backupPath)
        log.info('database migrated after backup', { schema: result.schemaVersion });
      this.#flushWaiters({ client });
    } catch (err) {
      const error = AppError.from(err);
      log.error('engine initialization failed', { code: error.code, err });
      if (FATAL_CODES.has(error.code)) {
        this.#setStatus({ state: 'failed', error: error.toJSON() });
        this.#flushWaiters({ error });
        this.#stopping = true;
      }
      child.kill(); // a non-fatal failure counts as a crash and is retried
    }
  }

  #onExit(child: UtilityProcess, client: Client, code: number): void {
    client.close(new AppError('engine_unavailable', 'The engine stopped.'));
    if (this.#child !== child) return;
    this.#child = null;
    this.#client = null;
    if (this.#stopping) return;

    const log = this.options.logger;
    const now = Date.now();
    this.#crashes = [...this.#crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    log.error('engine exited unexpectedly', { code, recentCrashes: this.#crashes.length });

    if (this.#crashes.length > MAX_CRASHES_IN_WINDOW) {
      const error = new AppError(
        'engine_unavailable',
        'The background engine keeps stopping. Restart the app; if it continues, check the logs.',
      );
      this.#setStatus({ state: 'failed', error: error.toJSON() });
      this.#flushWaiters({ error });
      return;
    }
    const delay =
      RESTART_DELAYS_MS[Math.min(this.#crashes.length - 1, RESTART_DELAYS_MS.length - 1)] ?? 1000;
    this.#setStatus({
      state: 'restarting',
      restarts: this.#status.restarts + 1,
      error: { code: 'engine_unavailable', message: `The engine stopped (exit code ${code}).` },
    });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#stopping) this.#spawn();
    }, delay);
  }
}
