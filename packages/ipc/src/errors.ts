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
  'cancelled',
  'not_found',
  'unsupported_file',
  'file_too_large',
  'ai_output_invalid',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SerializedError {
  code: ErrorCode;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  /** A temporary failure (server error, network blip) worth retrying. Not serialized. */
  readonly retryable: boolean;
  /** The model can't be used with this key (e.g. not on the free tier); another model may work. */
  readonly modelUnavailable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options?: ErrorOptions & { retryable?: boolean; modelUnavailable?: boolean },
  ) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.modelUnavailable = options?.modelUnavailable ?? false;
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
