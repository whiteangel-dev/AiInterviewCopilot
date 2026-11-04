import type { UpdateStatus } from '@aic/ipc';
import { useEffect, useState } from 'react';
import { invoke, on } from './api';

/** The automatic-update status, kept current. */
export function useUpdate(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void invoke('app:updateStatus')
      .then(setStatus)
      .catch(() => undefined);
    return on('app:update', setStatus);
  }, []);
  return status;
}

export function updateText(status: UpdateStatus): string {
  switch (status.state) {
    case 'disabled':
      return status.reason;
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return `Downloading version ${status.version}… ${status.percent}%`;
    case 'ready':
      return `Version ${status.version} is ready. It installs when you restart.`;
    case 'error':
      return status.message;
    case 'idle':
      return status.checkedAt
        ? 'You have the latest version.'
        : 'Checks for updates automatically.';
  }
}
