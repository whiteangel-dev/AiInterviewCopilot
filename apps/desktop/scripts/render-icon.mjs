// Renders the app icon (the Logo component's SVG) to build/icon.png at 1024×1024.
// electron-builder derives the Windows .ico from it. Run: npm run icon
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const SIZE = 1024;
const here = dirname(fileURLToPath(import.meta.url));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 34 34" width="${SIZE}" height="${SIZE}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
  <rect width="32" height="32" rx="7" fill="url(#g)"/>
  <path d="M7.5 12a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4h-5.3l-3.8 3.05c-.55.44-1.4.05-1.4-.66V20.8A4 4 0 0 1 7.5 17z" fill="#fff"/>
  <g fill="#5b50ea"><rect x="11.6" y="12.6" width="1.9" height="3.8" rx=".95"/>
  <rect x="15.05" y="10.6" width="1.9" height="7.8" rx=".95"/>
  <rect x="18.5" y="12.6" width="1.9" height="3.8" rx=".95"/></g></svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  const html = `<html><body style="margin:0;overflow:hidden;background:transparent"><style>svg{display:block}</style>${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = join(here, '..', 'build', 'icon.png');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG());
  writeFileSync(
    join(here, '..', 'resources', 'icon.png'),
    image.resize({ width: 256, height: 256 }).toPNG(),
  );
  console.log(`wrote ${out}`);
  app.quit();
});
