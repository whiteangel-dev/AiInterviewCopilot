/**
 * Errors that cross process boundaries. Kept free of runtime dependencies so the
 * sandboxed preload and the renderer can import it cheaply.
 */
export const ERROR_CODES = [
  'invalid_input',
  'invalid_api_key',
  'no_api_key',
  'network',
  'quota',
  'provider_error',
  'secure_storage_unavailable',
  'engine_unavailable',
  'db_unlock_failed',
  'db_newer_than_app',
  'timeout',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SerializedError {
  code: ErrorCode;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
  }

  toJSON(): SerializedError {
    return { code: this.code, message: this.message };
  }

  static from(err: unknown): AppError {
    if (err instanceof AppError) return err;
    if (isSerializedError(err)) return new AppError(err.code, err.message);
    const message = err instanceof Error ? err.message : String(err);
    return new AppError('internal', message, { cause: err });
  }
}

export function isSerializedError(value: unknown): value is SerializedError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.message === 'string' &&
    typeof v.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(v.code)
  );
}

/** Envelope for renderer → main calls, so error codes survive Electron's IPC. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: SerializedError };
