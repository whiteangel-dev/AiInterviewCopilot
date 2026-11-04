import { join } from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import type { Settings } from '@aic/ipc';
import { windowColors } from './theme';
import { restoreWindowState, saveWindowState } from './window-state';

export const COPILOT_MIN_SIZE = { width: 320, height: 240 };
const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 560;

export interface CopilotWindowOptions {
  url: string;
  preload: string;
  statePath: string;
  onVisibilityChange(visible: boolean): void;
}

/**
 * The always-on-top window shown during an interview: live transcript and
 * suggestions. Created on first use; closing it only hides it. It never takes
 * focus when it appears, so typing in the call app isn't interrupted.
 */
export class CopilotWindow {
  #win: BrowserWindow | null = null;
  #settings: Settings['copilot'] | null = null;
  #quitting = false;

  constructor(private readonly options: CopilotWindowOptions) {
    app.on('before-quit', () => (this.#quitting = true));
  }

  get visible(): boolean {
    return !!this.#win && !this.#win.isDestroyed() && this.#win.isVisible();
  }

  /** Applies the copilot settings now and to the window when it's created. */
  apply(settings: Settings['copilot']): void {
    this.#settings = settings;
    const win = this.#win;
    if (!win || win.isDestroyed()) return;
    win.setOpacity(settings.opacity);
    win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
    win.setContentProtection(settings.hideFromScreenShare);
  }

  show(): void {
    const win = this.#ensure();
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) {
      win.showInactive();
      this.options.onVisibilityChange(true);
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.#win!.hide();
    this.options.onVisibilityChange(false);
  }

  toggle(): boolean {
    if (this.visible) this.hide();
    else this.show();
    return this.visible;
  }

  destroy(): void {
    this.#quitting = true;
    if (this.#win && !this.#win.isDestroyed()) this.#win.destroy();
    this.#win = null;
  }

  #ensure(): BrowserWindow {
    if (this.#win && !this.#win.isDestroyed()) return this.#win;
    const primary = screen.getPrimaryDisplay().workArea;
    const saved = restoreWindowState(
      this.options.statePath,
      screen.getAllDisplays().map((d) => d.workArea),
      COPILOT_MIN_SIZE,
    );
    const bounds = saved?.bounds ?? {
      width: DEFAULT_WIDTH,
      height: Math.min(DEFAULT_HEIGHT, primary.height - 80),
      x: primary.x + primary.width - DEFAULT_WIDTH - 24,
      y: primary.y + 40,
    };
    const settings = this.#settings;
    const win = new BrowserWindow({
      ...bounds,
      minWidth: COPILOT_MIN_SIZE.width,
      minHeight: COPILOT_MIN_SIZE.height,
      show: false,
      frame: false,
      title: 'Copilot',
      backgroundColor: windowColors().background,
      skipTaskbar: true,
      alwaysOnTop: settings?.alwaysOnTop ?? true,
      fullscreenable: false,
      maximizable: false,
      ...(process.platform === 'linux'
        ? { icon: join(__dirname, '../../resources/icon.png') }
        : {}),
      webPreferences: {
        preload: this.options.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        navigateOnDragDrop: false,
        devTools: !app.isPackaged,
        // Keep the transcript updating while the window is behind others.
        backgroundThrottling: false,
      },
    });
    if (settings) {
      win.setOpacity(settings.opacity);
      win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
      win.setContentProtection(settings.hideFromScreenShare);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      if (win.isDestroyed() || win.isMinimized()) return;
      saveWindowState(this.options.statePath, { bounds: win.getBounds(), maximized: false });
    };
    const persistSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(persist, 500);
    };
    win.on('resize', persistSoon);
    win.on('move', persistSoon);
    win.on('close', (event) => {
      clearTimeout(timer);
      persist();
      if (!this.#quitting) {
        event.preventDefault();
        this.hide();
      }
    });
    win.on('closed', () => {
      if (this.#win === win) this.#win = null;
    });

    void win.loadURL(this.options.url);
    this.#win = win;
    return win;
  }
}
