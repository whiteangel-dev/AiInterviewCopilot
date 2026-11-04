/**
 * Preload for the hidden capture window (Electron's built-in capture). It has
 * no access to the app's IPC bridge: it only passes the engine's MessagePort,
 * sent by main, to the page.
 */
import { ipcRenderer } from 'electron';

// This file is type-checked with the Node project (no DOM types).
const page = globalThis as unknown as {
  location: { origin: string };
  postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void;
};

ipcRenderer.on('aic:capture-port', (event, request: unknown) => {
  page.postMessage({ type: 'aic-capture-port', request }, page.location.origin, event.ports);
});
