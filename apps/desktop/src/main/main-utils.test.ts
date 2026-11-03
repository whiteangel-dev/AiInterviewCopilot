import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, protocol: {}, session: {}, shell: {} }));

const { resolveAppFile } = await import('./app-protocol');
const { isTrustedUrl, originOf, trustedOrigins } = await import('./security');
const { restoreWindowState } = await import('./window-state');

describe('resolveAppFile', () => {
  const root = join(tmpdir(), 'renderer-root');
  it('maps app://renderer paths inside the root', () => {
    expect(resolveAppFile(root, 'app://renderer/')).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://renderer/assets/a.js?x=1')).toBe(
      join(root, 'assets', 'a.js'),
    );
  });
  it('blocks traversal, other hosts and schemes', () => {
    // Dot segments (plain or %2e-encoded) are resolved by the URL parser and stay inside root.
    expect(resolveAppFile(root, 'app://renderer/../secrets.json')).toBe(join(root, 'secrets.json'));
    expect(resolveAppFile(root, 'app://renderer/%2e%2e/%2e%2e/etc/passwd')).toBe(
      join(root, 'etc', 'passwd'),
    );
    // Encoded slashes survive URL parsing and would escape after decoding: rejected.
    expect(resolveAppFile(root, 'app://renderer/..%2f..%2fetc%2fpasswd')).toBeNull();
    expect(resolveAppFile(root, 'app://renderer/..%5c..%5cwindows%5cwin.ini')).toBeNull();
    expect(resolveAppFile(root, 'app://other/index.html')).toBeNull();
    expect(resolveAppFile(root, 'file:///etc/passwd')).toBeNull();
    expect(resolveAppFile(root, 'app://renderer/a%00.js')).toBeNull();
  });
});

describe('trusted origins', () => {
  it('handles the custom scheme, whose URL.origin is "null"', () => {
    expect(new URL('app://renderer/index.html').origin).toBe('null');
    expect(originOf('app://renderer/index.html')).toBe('app://renderer');
  });
  it('trusts only the app and the dev server', () => {
    const origins = trustedOrigins('http://localhost:5173', 'app://renderer');
    expect(isTrustedUrl('app://renderer/index.html', origins)).toBe(true);
    expect(isTrustedUrl('http://localhost:5173/', origins)).toBe(true);
    expect(isTrustedUrl('http://localhost:5174/', origins)).toBe(false);
    expect(isTrustedUrl('https://evil.example/', origins)).toBe(false);
    expect(isTrustedUrl('app://renderer.evil/x', origins)).toBe(false);
    expect(isTrustedUrl('not a url', origins)).toBe(false);
  });
});

describe('restoreWindowState', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aic-ws-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const screen = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  it('restores a visible window and enforces the minimum size', () => {
    writeFileSync(
      file,
      JSON.stringify({ bounds: { x: 100, y: 80, width: 300, height: 200 }, maximized: true }),
    );
    expect(restoreWindowState(file, screen)).toEqual({
      bounds: { x: 100, y: 80, width: 900, height: 600 },
      maximized: true,
    });
  });
  it('ignores windows left on a disconnected monitor, and junk', () => {
    writeFileSync(file, JSON.stringify({ bounds: { x: 2500, y: 100, width: 1000, height: 700 } }));
    expect(restoreWindowState(file, screen)).toBeNull();
    writeFileSync(file, '{"bounds":{"x":"a"}}');
    expect(restoreWindowState(file, screen)).toBeNull();
    expect(restoreWindowState(join(dir, 'missing.json'), screen)).toBeNull();
  });
});
