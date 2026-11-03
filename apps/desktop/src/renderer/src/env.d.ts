/// <reference types="vite/client" />
import type { AicBridge } from '@aic/ipc/channels';

declare global {
  interface Window {
    readonly aic: AicBridge;
  }
}
