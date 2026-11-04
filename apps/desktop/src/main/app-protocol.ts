import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { protocol, type Protocol } from 'electron';

/**
 * The packaged UI is served from `app://renderer/…` rather than `file://`, so it
 * gets a real origin, strict security headers, and no access to other files.
 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'renderer';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Must run before `app.ready`. */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** Maps an `app://renderer/…` URL to a file under `root`, or null if it escapes `root`. */
export function resolveAppFile(root: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // No legitimate asset path has a NUL or a backslash (a separator on Windows).
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const base = normalize(root);
  const file = normalize(join(base, pathname));
  return file.startsWith(base.endsWith(sep) ? base : base + sep) ? file : null;
}

/** Serves the UI on the default session, or on another session's `protocol`. */
export function handleAppProtocol(root: string, target: Protocol = protocol): void {
  target.handle(APP_SCHEME, async (request) => {
    const file = resolveAppFile(root, request.url);
    if (!file) return new Response('Forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': CONTENT_SECURITY_POLICY,
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Referrer-Policy': 'no-referrer',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
