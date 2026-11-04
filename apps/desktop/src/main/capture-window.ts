import {
  app,
  BrowserWindow,
  desktopCapturer,
  MessageChannelMain,
  session,
  type Session,
} from 'electron';
import type { Logger } from '@aic/core';
import type { CaptureRequest } from '@aic/ipc';
import { handleAppProtocol } from './app-protocol';
import type { EngineHost } from './engine-host';
import { excludeFromBroadcast } from './ipc';

export interface BuiltInCaptureOptions {
  /** URL of capture.html (app:// or the dev server). */
  url: string;
  preload: string;
  rendererRoot: string;
  host: EngineHost;
  log: Logger;
}

/** In-memory session just for capture, so media permissions never reach the app's windows. */
const PARTITION = 'aic-capture';

/**
 * Electron's built-in capture, the fallback when the native module can't be
 * used: a hidden window records the microphone (getUserMedia) and system audio
 * (getDisplayMedia loopback, Windows) and streams 16 kHz frames to the engine
 * over a MessagePort.
 */
export class BuiltInCapture {
  #win: BrowserWindow | null = null;
  #runId: string | null = null;
  #session: Session | null = null;

  constructor(private readonly options: BuiltInCaptureOptions) {}

  #captureSession(): Session {
    if (this.#session) return this.#session;
    const ses = session.fromPartition(PARTITION, { cache: false });
    handleAppProtocol(this.options.rendererRoot, ses.protocol);
    const isCaptureWindow = (contents: Electron.WebContents | null) =>
      !!contents && !!this.#win && !this.#win.isDestroyed() && contents === this.#win.webContents;
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      const media = details as { mediaTypes?: string[] };
      const audioOnly = (media.mediaTypes ?? []).every((t) => t === 'audio');
      callback(isCaptureWindow(contents) && permission === 'media' && audioOnly);
    });
    ses.setPermissionCheckHandler(
      (contents, permission) => isCaptureWindow(contents) && permission === 'media',
    );
    ses.setDisplayMediaRequestHandler((request, callback) => {
      const win = this.#win;
      if (!win || win.isDestroyed() || request.frame !== win.webContents.mainFrame) {
        callback({});
        return;
      }
      // Chromium requires a video source; the page stops the video track at once.
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const screen = sources[0];
          if (!screen) callback({});
          else if (process.platform === 'win32') callback({ video: screen, audio: 'loopback' });
          else callback({ video: screen });
        })
        .catch((err: unknown) => {
          this.options.log.warn('display media request failed', { err });
          callback({});
        });
    });
    this.#session = ses;
    return ses;
  }

  open(request: CaptureRequest): void {
    this.close();
    const log = this.options.log;
    this.#runId = request.runId;
    const win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      title: 'Audio capture',
      skipTaskbar: true,
      webPreferences: {
        preload: this.options.preload,
        session: this.#captureSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        devTools: !app.isPackaged,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    excludeFromBroadcast(win.webContents);
    this.#win = win;

    const fail = (message: string) => {
      log.warn('built-in capture failed', { message });
      void this.options.host
        .call('capture.failed', { runId: request.runId, message })
        .catch(() => undefined);
    };
    win.webContents.on('did-fail-load', (_e, code, description) => {
      fail(`The capture page failed to load (${code} ${description}).`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      if (this.#win === win) fail(`Built-in capture stopped (${details.reason}).`);
    });
    win.webContents.once('did-finish-load', () => {
      if (this.#win !== win) return;
      const { port1, port2 } = new MessageChannelMain();
      const sent = this.options.host.postPort(
        { kind: 'port', purpose: 'capture', runId: request.runId },
        port1,
      );
      if (!sent) {
        fail('The engine is not running.');
        return;
      }
      win.webContents.postMessage(
        'aic:capture-port',
        { runId: request.runId, microphone: request.microphone, system: request.system },
        [port2],
      );
      log.info('built-in capture started', {
        microphone: request.microphone,
        system: request.system,
      });
    });
    void win.loadURL(this.options.url);
  }

  close(runId?: string): void {
    if (runId && runId !== this.#runId) return;
    const win = this.#win;
    this.#win = null;
    this.#runId = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
