/**
 * Sandboxed preload: exposes a minimal, allowlisted bridge as `window.aic`.
 * No Node or Electron objects reach the page; main validates every payload.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, IPC_PREFIX, type AicBridge } from '@aic/ipc/channels';

const invokeChannels = new Set<string>(INVOKE_CHANNELS);
const eventChannels = new Set<string>(EVENT_CHANNELS);

const bridge: AicBridge = {
  invoke(channel, input) {
    if (!invokeChannels.has(channel))
      return Promise.reject(new Error(`Unknown channel: ${channel}`));
    return ipcRenderer.invoke(IPC_PREFIX + channel, input);
  },
  on(channel, listener) {
    if (!eventChannels.has(channel)) throw new Error(`Unknown event: ${channel}`);
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(IPC_PREFIX + channel, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_PREFIX + channel, wrapped);
    };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('aic', bridge);
