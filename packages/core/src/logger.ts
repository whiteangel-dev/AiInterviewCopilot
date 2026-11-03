import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
  close(): void;
}

export interface LoggerOptions {
  /** JSON-lines log file. Omit to log to the console only. */
  file?: string;
  level?: LogLevel;
  /** Also print to stderr. */
  console?: boolean;
  scope?: string;
  /** Rotate when the file grows past this size. */
  maxBytes?: number;
  /** Rotated files to keep (`app.log.1` … `app.log.N`). */
  maxFiles?: number;
}

function serializeError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  const code = (err as { code?: unknown }).code;
  if (code !== undefined) out.code = code;
  if (err.stack) out.stack = err.stack;
  if (err.cause !== undefined) out.cause = serializeError(err.cause);
  return out;
}

class FileSink {
  #fd: number | null = null;
  #size = 0;

  constructor(
    readonly path: string,
    readonly maxBytes: number,
    readonly maxFiles: number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.#open();
  }

  #open() {
    this.#fd = openSync(this.path, 'a', 0o600);
    try {
      this.#size = statSync(this.path).size;
    } catch {
      this.#size = 0;
    }
  }

  #rotate() {
    this.close();
    rmSync(`${this.path}.${this.maxFiles}`, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      try {
        renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      } catch {
        // missing, fine
      }
    }
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch {
      // missing, fine
    }
    this.#open();
  }

  write(line: string) {
    if (this.#fd === null) return;
    if (this.#size > 0 && this.#size + line.length > this.maxBytes) this.#rotate();
    if (this.#fd === null) return;
    // Synchronous on purpose: the last lines before a crash are the ones that matter.
    this.#size += writeSync(this.#fd, line);
  }

  close() {
    if (this.#fd !== null) closeSync(this.#fd);
    this.#fd = null;
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = LEVELS[options.level ?? 'info'];
  const sink = options.file
    ? new FileSink(options.file, options.maxBytes ?? 5 * 1024 * 1024, options.maxFiles ?? 3)
    : null;
  const toConsole = options.console ?? !sink;

  const make = (scope: string | undefined): Logger => {
    const log = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
      if (LEVELS[level] < minLevel) return;
      const entry: Record<string, unknown> = { t: new Date().toISOString(), level, msg: message };
      if (scope) entry.scope = scope;
      if (data) {
        for (const [k, v] of Object.entries(data)) {
          // Never let data overwrite the envelope (t, level, msg, scope).
          entry[k in entry || k === 'scope' ? `data.${k}` : k] = serializeError(v);
        }
      }
      let line: string;
      try {
        line = redact(JSON.stringify(entry)) + '\n';
      } catch {
        line = redact(JSON.stringify({ t: entry.t, level, msg: message, scope })) + '\n';
      }
      try {
        sink?.write(line);
      } catch {
        // never let logging take the process down
      }
      if (toConsole) process.stderr.write(line);
    };
    return {
      debug: (m, d) => log('debug', m, d),
      info: (m, d) => log('info', m, d),
      warn: (m, d) => log('warn', m, d),
      error: (m, d) => log('error', m, d),
      child: (child) => make(scope ? `${scope}.${child}` : child),
      close: () => sink?.close(),
    };
  };

  return make(options.scope);
}
