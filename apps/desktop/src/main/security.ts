import { app, session, shell, type WebContents } from 'electron';
import type { Logger } from '@aic/core';
import { ExternalUrlSchema } from '@aic/ipc';

/**
 * `scheme://host[:port]`. Unlike `URL.origin`, this also works for our custom
 * `app:` scheme, whose WHATWG origin is the opaque string "null".
 */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/** Origins our windows may load: the packaged UI, or the Vite dev server in development. */
export function trustedOrigins(devServerUrl: string | undefined, appOrigin: string): Set<string> {
  const origins = new Set([appOrigin]);
  const dev = devServerUrl ? originOf(devServerUrl) : null;
  if (dev) origins.add(dev);
  return origins;
}

export function isTrustedUrl(url: string, origins: ReadonlySet<string>): boolean {
  const origin = originOf(url);
  return origin !== null && origins.has(origin);
}

/**
 * App-wide hardening: no new windows, no navigation away from the app, no
 * permissions (camera, notifications, …), no <webview>. Allowed external links
 * open in the default browser.
 */
export function hardenWebContents(origins: ReadonlySet<string>, log: Logger): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    log.warn('permission request denied', { permission });
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (ExternalUrlSchema.safeParse(url).success) void shell.openExternal(url);
      else log.warn('blocked window.open', { origin: safeOrigin(url) });
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedUrl(url, origins)) {
        event.preventDefault();
        log.warn('blocked navigation', { origin: safeOrigin(url) });
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (!isTrustedUrl(url, origins)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function safeOrigin(url: string): string {
  return originOf(url) ?? '(invalid)';
}
