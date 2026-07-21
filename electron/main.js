const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { BitmapSubtitleService } = require('./bitmap-subtitles');
const { DynamicAudioService } = require('./dynamic-audio');

const PREFS_FILE = 'prefs.json';
const PLAYER_IDS = new Set(['video1', 'video2']);
const PLAYER2_MODES = new Set(['overlay', 'window']);

let mainWindow = null;
let player2Window = null;
let closingPairedWindows = false;
let closingPlayer2ForModeChange = false;
const bitmapSubtitleService = new BitmapSubtitleService(app);
const dynamicAudioService = new DynamicAudioService(app);

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

function resolveSubtitleFile(filePath) {
  const selected = resolveFile(filePath);
  if (!selected) return null;
  try {
    selected.content = fs.readFileSync(filePath, 'utf8');
    selected.format = path.extname(filePath).slice(1).toLowerCase();
  } catch {
    return null;
  }
  return selected;
}

function findMatchingSubtitleForVideo(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') return null;
  const parsed = path.parse(videoPath);
  const subtitlePath = path.join(parsed.dir, `${parsed.name}.srt`);
  return fs.existsSync(subtitlePath) ? resolveSubtitleFile(subtitlePath) : null;
}

async function probeVideoMetadata(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') return null;
  try {
    return await bitmapSubtitleService.getVideoMetadata(videoPath);
  } catch {
    return null;
  }
}

async function resolveVideoFile(filePath, options = {}) {
  const selected = resolveFile(filePath);
  if (!selected) return null;
  try {
    const inspected = await bitmapSubtitleService.inspectVideo(filePath);
    return {
      ...selected,
      ...(Number.isFinite(inspected.frameRate) ? { frameRate: inspected.frameRate } : {}),
      vobSubTracks: inspected.vobSubTracks,
      selectedVobSubTrack: inspected.selectedVobSubTrack,
      audioTracks: inspected.audioTracks,
      selectedAudioTrack: inspected.selectedAudioTrack
    };
  } catch {
    return {
      ...selected,
      vobSubTracks: [],
      selectedVobSubTrack: null,
      audioTracks: [],
      selectedAudioTrack: null
    };
  }
}

function normalizePlaybackSession(value) {
  if (!value || typeof value !== 'object') return null;

  const readNumberOrNull = (input) => {
    const num = Number(input);
    return Number.isFinite(num) ? num : null;
  };

  return {
    video1Time: readNumberOrNull(value.video1Time),
    video2Time: readNumberOrNull(value.video2Time),
    syncPoint1: readNumberOrNull(value.syncPoint1),
    syncPoint2: readNumberOrNull(value.syncPoint2),
    isSynced: !!value.isSynced,
    delay: Number.isFinite(Number(value.delay)) ? Number(value.delay) : 0,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now()
  };
}

function getIndexPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'web', 'index.html')
    : path.join(__dirname, '..', 'index.html');
}

function getPlayer2Mode() {
  const prefs = readPrefs();
  return PLAYER2_MODES.has(prefs.player2Mode) ? prefs.player2Mode : 'overlay';
}

function setPlayer2Mode(mode) {
  const nextMode = PLAYER2_MODES.has(mode) ? mode : 'overlay';
  const prefs = readPrefs();
  prefs.player2Mode = nextMode;
  writePrefs(prefs);
  return nextMode;
}

function isPlayer2WindowOpen() {
  return !!player2Window && !player2Window.isDestroyed();
}

function getModeState() {
  return {
    mode: getPlayer2Mode(),
    player2WindowOpen: isPlayer2WindowOpen()
  };
}

function sendToWindow(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    // no-op
  }
}

function closeWindowIfOpen(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.close();
  } catch {
    // no-op
  }
}

function broadcastModeState() {
  const payload = getModeState();
  sendToWindow(mainWindow, 'player2-mode:state', payload);
  sendToWindow(player2Window, 'player2-mode:state', payload);
}

function getSenderRole(sender) {
  if (mainWindow && mainWindow.webContents.id === sender.id) return 'main';
  if (player2Window && player2Window.webContents.id === sender.id) return 'player2';
  return 'main';
}

function buildWindow(options) {
  return new BrowserWindow({
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    ...options
  });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = buildWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680
  });

  mainWindow.on('close', () => {
    if (isPlayer2WindowOpen() && !closingPairedWindows) {
      closingPairedWindows = true;
      closeWindowIfOpen(player2Window);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!isPlayer2WindowOpen()) closingPairedWindows = false;
  });

  mainWindow.loadFile(getIndexPath());
  return mainWindow;
}

function createPlayer2Window() {
  if (isPlayer2WindowOpen()) {
    player2Window.show();
    player2Window.focus();
    return player2Window;
  }

  player2Window = buildWindow({
    width: 1100,
    height: 760,
    minWidth: 680,
    minHeight: 420,
    title: 'Dual Video Sync - Player 2'
  });

  player2Window.on('close', () => {
    if (!closingPlayer2ForModeChange && mainWindow && !mainWindow.isDestroyed() && !closingPairedWindows) {
      closingPairedWindows = true;
      closeWindowIfOpen(mainWindow);
    }
  });

  player2Window.on('closed', () => {
    player2Window = null;
    closingPlayer2ForModeChange = false;
    if (!mainWindow || mainWindow.isDestroyed()) closingPairedWindows = false;
    broadcastModeState();
  });

  player2Window.loadFile(getIndexPath());
  player2Window.webContents.once('did-finish-load', () => {
    broadcastModeState();
  });

  return player2Window;
}

async function applyPlayer2Mode(mode) {
  const nextMode = setPlayer2Mode(mode);
  if (nextMode === 'window') {
    createPlayer2Window();
  } else if (isPlayer2WindowOpen()) {
    closingPlayer2ForModeChange = true;
    closeWindowIfOpen(player2Window);
  }
  broadcastModeState();
  return getModeState();
}

app.whenReady().then(() => {
  createMainWindow();
  if (getPlayer2Mode() === 'window') {
    createPlayer2Window();
  }

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    if (getPlayer2Mode() === 'window' && !isPlayer2WindowOpen()) {
      createPlayer2Window();
    }
  });
});

app.on('window-all-closed', () => {
  dynamicAudioService.dispose();
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

  const selected = await resolveVideoFile(result.filePaths[0]);
  return selected || { canceled: true };
});

ipcMain.handle('dialog:open-subtitle', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Subtitle Files', extensions: ['srt', 'ass', 'ssa'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const selected = resolveSubtitleFile(result.filePaths[0]);
  return selected || { canceled: true };
});

ipcMain.handle('prefs:get-last-video', (_event, playerId) => {
  if (!PLAYER_IDS.has(playerId)) return null;
  const prefs = readPrefs();
  const videos = prefs.lastVideos || {};
  return resolveVideoFile(videos[playerId]);
});

ipcMain.handle('video:probe-metadata', (_event, filePath) => {
  return probeVideoMetadata(filePath);
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

ipcMain.handle('prefs:get-last-subtitle', (_event, playerId) => {
  if (!PLAYER_IDS.has(playerId)) return null;
  const prefs = readPrefs();
  const subtitles = prefs.lastSubtitles || {};
  return resolveSubtitleFile(subtitles[playerId]) || null;
});

ipcMain.handle('prefs:set-last-subtitle', (_event, { playerId, filePath }) => {
  if (!PLAYER_IDS.has(playerId)) return false;
  const prefs = readPrefs();
  const lastSubtitles = prefs.lastSubtitles && typeof prefs.lastSubtitles === 'object' ? prefs.lastSubtitles : {};
  if (typeof filePath === 'string' && filePath) {
    lastSubtitles[playerId] = filePath;
  } else {
    delete lastSubtitles[playerId];
  }
  prefs.lastSubtitles = lastSubtitles;
  writePrefs(prefs);
  return true;
});

ipcMain.handle('subtitle:find-for-video', (_event, videoPath) => {
  return findMatchingSubtitleForVideo(videoPath);
});

ipcMain.handle('subtitle:load-vobsub-track', (_event, { filePath, streamIndex }) => {
  if (typeof filePath !== 'string' || !filePath || !Number.isInteger(Number(streamIndex))) return null;
  return bitmapSubtitleService.loadTrack(filePath, Number(streamIndex));
});

ipcMain.handle('subtitle:load-embedded-track', (_event, { filePath, streamIndex }) => {
  if (typeof filePath !== 'string' || !filePath || !Number.isInteger(Number(streamIndex))) return null;
  return bitmapSubtitleService.loadTrack(filePath, Number(streamIndex));
});

ipcMain.handle('audio:prepare-track', async (event, { filePath, streamIndex, requestId }) => {
  if (typeof filePath !== 'string' || !filePath || !Number.isInteger(Number(streamIndex))) return null;
  const inspected = await bitmapSubtitleService.inspectVideo(filePath);
  const track = inspected.audioTracks.find((candidate) => candidate.streamIndex === Number(streamIndex));
  if (!track) throw new Error('The requested audio track was not found.');
  return {
    ...await dynamicAudioService.prepareTrack(filePath, track, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('audio:conversion-progress', { requestId, progress });
      }
    }),
    track
  };
});

ipcMain.handle('prefs:get-playback-session', () => {
  const prefs = readPrefs();
  return normalizePlaybackSession(prefs.playbackSession);
});

ipcMain.handle('prefs:set-playback-session', (_event, session) => {
  const normalized = normalizePlaybackSession(session);
  if (!normalized) return false;
  const prefs = readPrefs();
  prefs.playbackSession = normalized;
  writePrefs(prefs);
  return true;
});

ipcMain.handle('prefs:get-player2-mode', () => getModeState());

ipcMain.handle('prefs:set-player2-mode', async (_event, mode) => {
  return applyPlayer2Mode(mode);
});

ipcMain.handle('player2-window:show', async () => {
  if (getPlayer2Mode() !== 'window') {
    setPlayer2Mode('window');
  }
  createPlayer2Window();
  broadcastModeState();
  return getModeState();
});

ipcMain.handle('window:get-context', (event) => {
  return {
    role: getSenderRole(event.sender),
    ...getModeState()
  };
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

ipcMain.on('player:event', (event, message) => {
  if (!message || typeof message !== 'object') return;
  const senderRole = getSenderRole(event.sender);
  if (senderRole === 'main') {
    sendToWindow(player2Window, 'player:event', message);
    return;
  }
  sendToWindow(mainWindow, 'player:event', message);
});
