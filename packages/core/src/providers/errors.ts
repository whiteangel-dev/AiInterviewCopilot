const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** True for DNS, connection, TLS and timeout failures (including fetch's "fetch failed"). */
export function isNetworkError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (typeof e !== 'object') return false;
    const { name, code, message, cause } = e as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
    if (name === 'TypeError' && message === 'fetch failed') return true;
    e = cause;
  }
  return false;
}
