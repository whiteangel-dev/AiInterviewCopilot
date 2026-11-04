import type { PhoneStatus } from '@aic/ipc';
import { useEffect, useState } from 'react';
import { invoke, on } from './api';

/** The phone screen's status, kept current. */
export function usePhone(): PhoneStatus | null {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  useEffect(() => {
    void invoke('phone:status')
      .then(setStatus)
      .catch(() => undefined);
    return on('phone:status', setStatus);
  }, []);
  return status;
}
