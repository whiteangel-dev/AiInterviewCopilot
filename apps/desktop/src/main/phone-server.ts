import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import type { Logger } from '@aic/core';
import type { AnswerLength, LiveAnswer, LiveState, LiveTranscript } from '@aic/ipc';

/**
 * The phone as a second screen (Phase 8). While turned on, a small web server
 * on the local network serves one page (`phone.html`) and a live feed of the
 * interview: state, transcript and answers. A phone on the same Wi-Fi opens it
 * by scanning a QR code that carries a random pairing token; every request
 * needs that token (as an HttpOnly cookie after the first visit). Nothing else
 * in the app (profiles, notes, keys) is reachable.
 *
 * Main only forwards events it already sends to the windows, so the answer
 * path is unaffected. Plain HTTP: browsers allow nothing else for a local
 * address without certificate warnings. Use it on a private network.
 */

export interface PhoneSnapshot {
  state: LiveState | null;
  transcript: LiveTranscript | null;
  answers: LiveAnswer[];
}

export interface PhoneCommands {
  snapshot(): Promise<PhoneSnapshot>;
  answerNow(): Promise<void>;
  regenerate(answerId: string | null, length: AnswerLength | null): Promise<void>;
}

export interface PhoneServerOptions {
  /** The built renderer (out/renderer): phone.html and its assets. */
  rendererRoot: string;
  commands: PhoneCommands;
  log: Logger;
  /** Ports tried in order (the first free one is used). */
  ports?: readonly number[];
  /** Listen address (tests use 127.0.0.1). */
  host?: string;
  onClients?(count: number): void;
}

const COOKIE = 'aic_phone';
const PORTS = Array.from({ length: 20 }, (_, i) => 47_600 + i);
const MAX_BODY = 2048;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function newPhoneToken(): string {
  return randomBytes(24).toString('base64url');
}

/** This computer's addresses on the local network, private ranges first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        out.push(a.address);
      }
    }
  }
  const isPrivate = (ip: string) =>
    ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class PhoneServer {
  #server: Server | null = null;
  #port: number | null = null;
  #token: string;
  readonly #clients = new Set<ServerResponse>();
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(
    token: string,
    private readonly o: PhoneServerOptions,
  ) {
    this.#token = token;
  }

  get port(): number | null {
    return this.#port;
  }

  get clients(): number {
    return this.#clients.size;
  }

  get running(): boolean {
    return this.#server !== null;
  }

  /** Links a phone can open, one per local address. */
  urls(): string[] {
    if (this.#port === null) return [];
    const hosts = this.o.host && this.o.host !== '0.0.0.0' ? [this.o.host] : lanAddresses();
    return hosts.map((h) => `http://${h}:${this.#port}/?k=${this.#token}`);
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        this.o.log.warn('phone request failed', { err });
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    for (const port of this.o.ports ?? PORTS) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, this.o.host ?? '0.0.0.0', () => {
            server.off('error', reject);
            resolve();
          });
        });
        const address = server.address();
        this.#port = typeof address === 'object' && address ? address.port : port;
        this.#server = server;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      }
    }
    if (!this.#server) throw new Error('No free port for the phone screen.');
    this.#heartbeat = setInterval(() => this.#send(': ping\n\n'), 15_000);
    this.#heartbeat.unref();
    this.o.log.info('phone screen on', { port: this.#port });
  }

  async stop(): Promise<void> {
    clearInterval(this.#heartbeat);
    for (const c of this.#clients) c.end();
    this.#clients.clear();
    this.o.onClients?.(0);
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** A new token: phones paired so far are disconnected and must scan again. */
  setToken(token: string): void {
    this.#token = token;
    for (const c of this.#clients) c.end();
    this.#clients.clear();
    this.o.onClients?.(0);
  }

  /** Sends a live event to every connected phone. */
  broadcast(event: string, data: unknown): void {
    if (this.#clients.size === 0) return;
    this.#send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  #send(chunk: string) {
    for (const c of this.#clients) c.write(chunk);
  }

  #authorized(req: IncomingMessage, url: URL): 'query' | 'cookie' | null {
    const k = url.searchParams.get('k');
    if (k && same(k, this.#token)) return 'query';
    const cookie = req.headers.cookie
      ?.split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    return cookie && same(cookie, this.#token) ? 'cookie' : null;
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://phone');
    const auth = this.#authorized(req, url);
    if (!auth) {
      res
        .writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
        .end('This link has expired. Scan the QR code in AI Interview Copilot again.');
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/phone.html')) {
      const html = await readFile(join(this.o.rendererRoot, 'phone.html'));
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME['.html'],
        'Cache-Control': 'no-store',
        // Later requests (scripts, the feed) carry the token as a cookie.
        'Set-Cookie': `${COOKIE}=${this.#token}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const base = normalize(join(this.o.rendererRoot, 'assets'));
      const file = normalize(join(this.o.rendererRoot, decodeURIComponent(url.pathname)));
      const type = MIME[extname(file)];
      if (!file.startsWith(base + sep) || !type) {
        res.writeHead(404, SECURITY_HEADERS).end();
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': type,
          'Cache-Control': 'max-age=3600',
        });
        res.end(body);
      } catch {
        res.writeHead(404, SECURITY_HEADERS).end();
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(await this.o.commands.snapshot())}\n\n`);
      this.#clients.add(res);
      this.o.onClients?.(this.#clients.size);
      req.on('close', () => {
        this.#clients.delete(res);
        this.o.onClients?.(this.#clients.size);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/command') {
      // A custom header can't be sent cross-site without a preflight we never answer.
      if (req.headers['x-aic-phone'] !== '1') {
        res.writeHead(403, SECURITY_HEADERS).end();
        return;
      }
      const body = await readBody(req);
      let command: { action?: unknown; answerId?: unknown; length?: unknown };
      try {
        command = JSON.parse(body) as typeof command;
      } catch {
        res.writeHead(400, SECURITY_HEADERS).end();
        return;
      }
      try {
        if (command.action === 'answerNow') {
          await this.o.commands.answerNow();
        } else if (command.action === 'regenerate') {
          const answerId =
            typeof command.answerId === 'string' && command.answerId.length <= 64
              ? command.answerId
              : null;
          const length =
            command.length === 'short' ||
            command.length === 'standard' ||
            command.length === 'detailed'
              ? command.length
              : null;
          await this.o.commands.regenerate(answerId, length);
        } else {
          res.writeHead(400, SECURITY_HEADERS).end();
          return;
        }
        res
          .writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' })
          .end('{"ok":true}');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        res
          .writeHead(409, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: false, message }));
      }
      return;
    }

    res.writeHead(404, SECURITY_HEADERS).end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
