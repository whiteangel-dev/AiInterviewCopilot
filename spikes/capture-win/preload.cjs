// Minimal, typed-by-convention bridge. The page gets no Node.js access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  saveFile: (name, data) => ipcRenderer.invoke('save-file', name, data),
  metrics: () => ipcRenderer.invoke('metrics'),
  systemInfo: () => ipcRenderer.invoke('system-info'),
});
