// Phase 0 — Option A capture spike: Electron main process.
// Grants loopback system audio via getDisplayMedia and saves recordings/reports.
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REC_DIR = path.join(__dirname, 'recordings');

function createWindow() {
  const win = new BrowserWindow({
    width: 820,
    height: 720,
    title: 'AI Interview Copilot — capture spike',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep audio processing alive when the window is hidden
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  // getDisplayMedia() in the page gets the primary screen + system audio loopback.
  // The video track is discarded by the renderer; only audio is used.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: 'loopback' });
    } catch (err) {
      console.error('display media handler failed', err);
      callback({});
    }
  });

  // Local test page only: allow microphone/screen media permission requests.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'display-capture'));

  ipcMain.handle('save-file', (_e, name, data) => {
    fs.mkdirSync(REC_DIR, { recursive: true });
    const safe = path.basename(String(name)).replace(/[^\w.-]/g, '_');
    const file = path.join(REC_DIR, safe);
    fs.writeFileSync(file, Buffer.from(data));
    return file;
  });

  ipcMain.handle('metrics', () => {
    const metrics = app.getAppMetrics();
    return {
      cpuPercent: metrics.reduce((s, p) => s + p.cpu.percentCPUUsage, 0),
      memoryMB: metrics.reduce((s, p) => s + p.memory.workingSetSize, 0) / 1024,
    };
  });

  ipcMain.handle('system-info', () => ({
    platform: process.platform,
    osRelease: os.release(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    recordingsDir: REC_DIR,
  }));

  createWindow();
});

app.on('window-all-closed', () => app.quit());
