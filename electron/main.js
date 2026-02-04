const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PREFS_FILE = 'prefs.json';
const PLAYER_IDS = new Set(['video1', 'video2']);

function getPrefsPath() {
  return path.join(app.getPath('userData'), PREFS_FILE);
}

function readPrefs() {
  try {
    const data = fs.readFileSync(getPrefsPath(), 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function writePrefs(prefs) {
  try {
    fs.writeFileSync(getPrefsPath(), JSON.stringify(prefs, null, 2), 'utf8');
  } catch {
    // no-op: app still works without persistence
  }
}

function resolveFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  return {
    path: filePath,
    name: path.basename(filePath),
    fileUrl: pathToFileURL(filePath).toString()
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const indexPath = app.isPackaged
    ? path.join(process.resourcesPath, 'web', 'index.html')
    : path.join(__dirname, '..', 'index.html');
  win.loadFile(indexPath);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('dialog:open-video', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Video Files', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const selected = resolveFile(result.filePaths[0]);
  return selected || { canceled: true };
});

ipcMain.handle('prefs:get-last-video', (_event, playerId) => {
  if (!PLAYER_IDS.has(playerId)) return null;
  const prefs = readPrefs();
  const videos = prefs.lastVideos || {};
  return resolveFile(videos[playerId]) || null;
});

ipcMain.handle('prefs:set-last-video', (_event, { playerId, filePath }) => {
  if (!PLAYER_IDS.has(playerId) || typeof filePath !== 'string' || !filePath) return false;
  const prefs = readPrefs();
  const lastVideos = prefs.lastVideos && typeof prefs.lastVideos === 'object' ? prefs.lastVideos : {};
  lastVideos[playerId] = filePath;
  prefs.lastVideos = lastVideos;
  writePrefs(prefs);
  return true;
});

ipcMain.handle('zoom:get-factor', (event) => {
  return event.sender.getZoomFactor();
});

ipcMain.handle('zoom:set-factor', (event, factor) => {
  const next = Number(factor);
  if (!Number.isFinite(next)) return event.sender.getZoomFactor();
  const clamped = Math.max(0.25, Math.min(3, next));
  event.sender.setZoomFactor(clamped);
  return clamped;
});
