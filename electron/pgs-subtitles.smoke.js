const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain } = require('electron');
const { BitmapSubtitleService } = require('./bitmap-subtitles');

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `FFmpeg exited with ${code}`)));
  });
}

async function createFixture(service, fixtureDir) {
  const supPath = path.join(__dirname, 'test-fixtures', 'libpgs-js-test.sup');
  const mkvPath = path.join(fixtureDir, 'embedded-pgs.mkv');
  if (!fs.existsSync(supPath)) throw new Error(`Missing PGS test fixture: ${supPath}`);
  await run(service.ffmpegPath, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=4',
    '-i', supPath,
    '-map', '0:v:0', '-map', '1:0',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '250k',
    '-c:s', 'copy',
    '-metadata:s:s:0', 'language=eng',
    '-metadata:s:s:0', 'title=English PGS',
    mkvPath
  ]);
  return mkvPath;
}

async function runSmoke() {
  const fixtureDir = path.join(os.tmpdir(), `dual-video-sync-pgs-smoke-${process.pid}`);
  fs.mkdirSync(fixtureDir, { recursive: true });
  app.setPath('userData', path.join(fixtureDir, 'user-data'));
  const service = new BitmapSubtitleService(app);
  const fixturePath = await createFixture(service, fixtureDir);
  const inspected = await service.inspectVideo(fixturePath);
  const track = inspected.selectedVobSubTrack;
  if (!track || track.renderer !== 'bitmap' || track.bitmapFormat !== 'pgs' || track.language !== 'eng') {
    throw new Error(`PGS discovery/default selection failed: ${JSON.stringify(inspected.vobSubTracks)}`);
  }

  const extracted = await service.loadTrack(fixturePath, track.streamIndex);
  const extractedBytes = Buffer.from(extracted.content);
  if (!extracted.fileName.endsWith('.sup') || extractedBytes.length < 100 || extractedBytes.subarray(0, 2).toString('ascii') !== 'PG') {
    throw new Error('Lossless PGS extraction did not produce a valid raw SUP stream.');
  }

  ipcMain.handle('subtitle:load-embedded-track', (_event, { filePath, streamIndex }) => service.loadTrack(filePath, Number(streamIndex)));
  ipcMain.handle('window:get-context', () => ({ role: 'main', mode: 'overlay', player2WindowOpen: false }));
  ipcMain.handle('zoom:get-factor', () => 1);
  ipcMain.handle('zoom:set-factor', () => 1);
  ipcMain.handle('prefs:get-last-video', () => null);
  ipcMain.handle('prefs:set-last-video', () => true);
  ipcMain.handle('prefs:get-last-subtitle', () => null);
  ipcMain.handle('prefs:set-last-subtitle', () => true);
  ipcMain.handle('prefs:get-playback-session', () => null);
  ipcMain.handle('prefs:set-playback-session', () => true);
  ipcMain.handle('prefs:get-player2-mode', () => ({ mode: 'overlay', player2WindowOpen: false }));

  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      consoleErrors.push(`${details.sourceId || 'renderer'}:${details.lineNumber || 0} ${details.message}`);
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'), { query: { 'vobsub-smoke': '1' } });
  win.setPosition(-10000, -10000);
  win.showInactive();
  const sourceUrl = pathToFileURL(fixturePath).href;
  const result = await win.webContents.executeJavaScript(`(async () => {
    const waitUntil = async (predicate, timeoutMs, label) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for ' + label);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    await waitUntil(() => window.bitmapSubtitleAPI && window.__dvsVobSubSmoke, 10000, 'PGS renderer and app controls');
    await window.bitmapSubtitleAPI.ready;
    document.getElementById('overlayPlayer').style.display = 'none';
    document.getElementById('syncControls').style.display = 'none';
    document.querySelector('#mainPlayer .controls').style.display = 'none';
    document.getElementById('vobSubIndicator1').style.display = 'none';
    document.getElementById('audioIndicator1').style.display = 'none';
    document.getElementById('subtitle1Display').style.display = 'none';

    const video = document.getElementById('video1');
    video.muted = true;
    video.src = ${JSON.stringify(sourceUrl)};
    video.load();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video metadata did not load')), 10000);
      video.addEventListener('loadedmetadata', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });

    const smoke = window.__dvsVobSubSmoke;
    smoke.setVideoPath(1, ${JSON.stringify(fixturePath)});
    const selected = smoke.prepareTracks('video1', ${JSON.stringify(inspected)}, ${JSON.stringify(fixturePath)});
    await smoke.selectTrack(1, selected.streamIndex);
    await waitUntil(() => smoke.getRenderer(1), 10000, 'app PGS renderer');
    const renderer = smoke.getRenderer(1);
    await waitUntil(() => document.getElementById('vobSubTrackStatus1').textContent.startsWith('Ready:'), 10000, 'PGS ready state');
    video.currentTime = 0.5;
    await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
    await waitUntil(() => renderer.getCurrentCueMetadata?.() !== null, 10000, 'active PGS cue');
    const renderDeadline = Date.now() + 10000;
    while (renderer.getLastRenderInfo?.()?.status !== 'rendered' && Date.now() < renderDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const canvas = renderer.canvas;
    const rect = canvas.getBoundingClientRect();
    return {
      sourceUnchanged: video.currentSrc === ${JSON.stringify(sourceUrl)},
      canvasAttached: canvas.parentElement === video.parentElement,
      canvasSize: [canvas.width, canvas.height],
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      selectorValue: document.getElementById('vobSubTrackSelect1').value,
      selectorOptions: Array.from(document.getElementById('vobSubTrackSelect1').options, (option) => option.textContent),
      statusText: document.getElementById('vobSubTrackStatus1').textContent,
      rendererDebug: renderer.debug,
      rendererClass: renderer.constructor.name,
      cue: renderer.getCurrentCueMetadata(),
      renderInfo: renderer.getLastRenderInfo()
    };
  })()`);

  const rect = result.rect;
  const image = await win.webContents.capturePage({
    x: Math.max(0, Math.floor(rect.x)),
    y: Math.max(0, Math.floor(rect.y)),
    width: Math.max(1, Math.floor(rect.width)),
    height: Math.max(1, Math.floor(rect.height))
  });
  const screenshotPath = path.join(os.tmpdir(), 'dual-video-sync-pgs-smoke.png');
  fs.writeFileSync(screenshotPath, image.toPNG());
  const bitmap = image.toBitmap();
  let coloredPixels = 0;
  for (let index = 0; index < bitmap.length; index += 4) {
    const blue = bitmap[index];
    const green = bitmap[index + 1];
    const red = bitmap[index + 2];
    if (red > 35 || green > 35 || blue > 35) coloredPixels += 1;
  }

  if (!result.sourceUnchanged) throw new Error('PGS rendering replaced or transcoded the video source.');
  if (!result.canvasAttached || result.canvasSize[0] < 1 || result.canvasSize[1] < 1) throw new Error('The PGS canvas was not attached and sized.');
  if (result.selectorValue !== String(track.streamIndex) || !result.selectorOptions.some((option) => option.includes('PGS'))) {
    throw new Error(`The PGS track selector was incorrect: ${JSON.stringify(result.selectorOptions)}`);
  }
  if (!result.statusText.startsWith('Ready:') || !result.cue || result.renderInfo?.status !== 'rendered') {
    throw new Error(`PGS did not reach a rendered ready state: ${JSON.stringify(result)}`);
  }
  if (coloredPixels < 100) throw new Error(`The PGS canvas did not visibly render (${coloredPixels} colored pixels).`);
  const relevantConsoleErrors = consoleErrors.filter((message) => (
    !/Electron Security Warning|powerPreference option is currently ignored/.test(message)
  ));
  if (relevantConsoleErrors.length > 0) throw new Error(`Renderer console errors: ${relevantConsoleErrors.join(' | ')}`);

  await win.webContents.executeJavaScript('window.__dvsVobSubSmoke.getRenderer(1)?.dispose()');
  console.log(JSON.stringify({ ok: true, track, extractedBytes: extractedBytes.length, coloredPixels, screenshotPath, ...result }));
  win.destroy();
}

app.whenReady()
  .then(runSmoke)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
