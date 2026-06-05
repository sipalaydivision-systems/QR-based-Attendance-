const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('edutrack', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  checkConnection: () => ipcRenderer.invoke('connection:check'),
  submitScan: (payload) => ipcRenderer.invoke('scan:submit', payload),
  syncQueue: () => ipcRenderer.invoke('queue:sync'),
  getQueue: () => ipcRenderer.invoke('queue:get'),
  toggleFullscreen: () => ipcRenderer.invoke('app:fullscreen'),
  minimize: () => ipcRenderer.invoke('app:minimize'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  showError: (message) => ipcRenderer.invoke('app:show-error', message),
  onQueueStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('queue:status', listener);
    return () => ipcRenderer.removeListener('queue:status', listener);
  }
});
