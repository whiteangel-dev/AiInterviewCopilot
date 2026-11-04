import type { CaptureBackend } from '@aic/ipc';

export const BACKEND_LABEL: Record<CaptureBackend, string> = {
  native: 'Windows audio (native)',
  browser: 'Built-in capture',
  replay: 'Test recordings',
};
