const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openVideoFile: () => ipcRenderer.invoke('dialog:open-video'),
  getLastVideo: (playerId) => ipcRenderer.invoke('prefs:get-last-video', playerId),
  setLastVideo: (playerId, filePath) => ipcRenderer.invoke('prefs:set-last-video', { playerId, filePath }),
  getZoomFactor: () => ipcRenderer.invoke('zoom:get-factor'),
  setZoomFactor: (factor) => ipcRenderer.invoke('zoom:set-factor', factor)
});
