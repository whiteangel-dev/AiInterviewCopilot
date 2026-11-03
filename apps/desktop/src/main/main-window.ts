import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme, screen } from 'electron';
import { TITLEBAR_HEIGHT, windowColors } from './theme';
import { DEFAULT_SIZE, MIN_SIZE, restoreWindowState, saveWindowState } from './window-state';

export interface MainWindowOptions {
  url: string;
  preload: string;
  statePath: string;
}

export function createMainWindow({ url, preload, statePath }: MainWindowOptions): BrowserWindow {
  const saved = restoreWindowState(
    statePath,
    screen.getAllDisplays().map((d) => d.workArea),
  );
  const colors = windowColors();
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    ...(saved?.bounds ?? DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'AI Interview Copilot',
    backgroundColor: colors.background,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? {}
      : {
          titleBarOverlay: {
            color: colors.background,
            symbolColor: colors.symbol,
            height: TITLEBAR_HEIGHT,
          },
        }),
    ...(process.platform === 'linux' ? { icon: join(__dirname, '../../resources/icon.png') } : {}),
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });

  if (saved?.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  const persist = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    saveWindowState(statePath, { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persistSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(persist, 500);
  };
  win.on('resize', persistSoon);
  win.on('move', persistSoon);
  win.on('close', () => {
    clearTimeout(timer);
    persist();
  });

  if (!isMac) {
    const updateOverlay = () => {
      if (win.isDestroyed()) return;
      const c = windowColors();
      win.setBackgroundColor(c.background);
      win.setTitleBarOverlay({
        color: c.background,
        symbolColor: c.symbol,
        height: TITLEBAR_HEIGHT,
      });
    };
    nativeTheme.on('updated', updateOverlay);
    win.on('closed', () => nativeTheme.off('updated', updateOverlay));
  }

  void win.loadURL(url);
  return win;
}
