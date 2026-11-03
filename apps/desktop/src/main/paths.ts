import { join } from 'node:path';
import { app } from 'electron';

export interface AppPaths {
  userData: string;
  logs: string;
  dataDir: string;
  db: string;
  backups: string;
  secrets: string;
  windowState: string;
  uiCache: string;
}

export function appPaths(): AppPaths {
  const userData = app.getPath('userData');
  const dataDir = join(userData, 'data');
  return {
    userData,
    logs: app.getPath('logs'),
    dataDir,
    db: join(dataDir, 'app.db'),
    backups: join(dataDir, 'backups'),
    secrets: join(userData, 'secrets.json'),
    windowState: join(userData, 'window-state.json'),
    uiCache: join(userData, 'ui-cache.json'),
  };
}
