const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openVideoFile: () => ipcRenderer.invoke('dialog:open-video'),
  openSubtitleFile: () => ipcRenderer.invoke('dialog:open-subtitle'),
  getLastVideo: (playerId) => ipcRenderer.invoke('prefs:get-last-video', playerId),
  setLastVideo: (playerId, filePath) => ipcRenderer.invoke('prefs:set-last-video', { playerId, filePath }),
  getLastSubtitle: (playerId) => ipcRenderer.invoke('prefs:get-last-subtitle', playerId),
  setLastSubtitle: (playerId, filePath) => ipcRenderer.invoke('prefs:set-last-subtitle', { playerId, filePath }),
  findSubtitleForVideo: (videoPath) => ipcRenderer.invoke('subtitle:find-for-video', videoPath),
  probeVideoMetadata: (videoPath) => ipcRenderer.invoke('video:probe-metadata', videoPath),
  getPlaybackSession: () => ipcRenderer.invoke('prefs:get-playback-session'),
  setPlaybackSession: (session) => ipcRenderer.invoke('prefs:set-playback-session', session),
  getPlayer2Mode: () => ipcRenderer.invoke('prefs:get-player2-mode'),
  setPlayer2Mode: (mode) => ipcRenderer.invoke('prefs:set-player2-mode', mode),
  showPlayer2Window: () => ipcRenderer.invoke('player2-window:show'),
  getWindowContext: () => ipcRenderer.invoke('window:get-context'),
  getZoomFactor: () => ipcRenderer.invoke('zoom:get-factor'),
  setZoomFactor: (factor) => ipcRenderer.invoke('zoom:set-factor', factor),
  sendPlayerEvent: (payload) => ipcRenderer.send('player:event', payload),
  onPlayerEvent: (callback) => {
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on('player:event', wrapped);
    return () => ipcRenderer.removeListener('player:event', wrapped);
  },
  onPlayer2ModeState: (callback) => {
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on('player2-mode:state', wrapped);
    return () => ipcRenderer.removeListener('player2-mode:state', wrapped);
  }
});
