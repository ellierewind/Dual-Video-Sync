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
  const assPath = path.join(fixtureDir, 'full-ass.ass');
  const japaneseAssPath = path.join(fixtureDir, 'japanese.ass');
  const mkvPath = path.join(fixtureDir, 'full-ass.mkv');
  const fontPath = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'segoeui.ttf')
  ].find((candidate) => fs.existsSync(candidate));
  if (!fontPath) throw new Error('No Windows TrueType font was available for the ASS smoke fixture.');

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Full,Arial,42,&H0000FFFF,&H000000FF,&H00000000,&H60000000,-1,0,0,0,100,100,1,0,1,3,2,8,20,20,24,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Full,,0,0,0,,{\\an8\\pos(320,135)\\fad(100,100)\\t(0,2500,\\frz360)\\k40}FULL {\\i1}ASS{\\i0} / SSA
Dialogue: 1,0:00:00.00,0:00:05.00,Full,,0,0,0,,{\\an5\\p1\\1c&H00FF00&\\bord2}m -80 -20 l 80 -20 80 20 -80 20{\\p0}
`;
  fs.writeFileSync(assPath, ass, 'utf8');
  fs.writeFileSync(japaneseAssPath, ass.replace('FULL {\\i1}ASS{\\i0} / SSA', 'JAPANESE ASS'), 'utf8');
  await run(service.ffmpegPath, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=6',
    '-i', japaneseAssPath,
    '-i', assPath,
    '-map', '0:v:0', '-map', '1:0', '-map', '2:0',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '350k',
    '-c:s', 'copy',
    '-metadata:s:s:0', 'language=jpn',
    '-metadata:s:s:0', 'title=Japanese',
    '-disposition:s:0', 'default',
    '-metadata:s:s:1', 'language=eng',
    '-metadata:s:s:1', 'title=English Full ASS',
    '-disposition:s:1', '0',
    '-attach', fontPath,
    '-metadata:s:t:0', 'mimetype=application/x-truetype-font',
    '-metadata:s:t:0', `filename=${path.basename(fontPath)}`,
    mkvPath
  ]);
  return mkvPath;
}

async function runSmoke() {
  const fixtureDir = path.join(os.tmpdir(), `dual-video-sync-ass-smoke-${process.pid}`);
  fs.mkdirSync(fixtureDir, { recursive: true });
  const service = new BitmapSubtitleService(app);
  const fixturePath = await createFixture(service, fixtureDir);
  const replacementPath = path.join(fixtureDir, 'replacement-full-ass.mkv');
  fs.copyFileSync(fixturePath, replacementPath);
  const inspected = await service.inspectVideo(fixturePath);
  const track = inspected.selectedVobSubTrack;
  if (!track || track.renderer !== 'ass' || track.language !== 'eng') {
    throw new Error(`ASS discovery/default selection failed: ${JSON.stringify(inspected.vobSubTracks)}`);
  }
  const extracted = await service.loadTrack(fixturePath, track.streamIndex);
  if (!String(extracted.content).includes('[V4+ Styles]') || !String(extracted.content).includes('\\t(')) {
    throw new Error('Lossless ASS extraction did not preserve styles and override tags.');
  }
  if (!Array.isArray(extracted.fonts) || extracted.fonts.length !== 1 || extracted.fonts[0].byteLength < 1000) {
    throw new Error('The MKV font attachment was not extracted for libass.');
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
    await waitUntil(() => window.assSubtitleAPI && window.__dvsVobSubSmoke, 10000, 'ASS renderer and app controls');
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
    const selector = document.getElementById('vobSubTrackSelect1');
    const settings = document.getElementById('settings1');
    document.getElementById('settingsToggle1').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    selector.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const menuStayedOpen = settings.classList.contains('open');
    await smoke.selectTrack(1, selected.streamIndex);
    await waitUntil(() => smoke.getRenderer(1), 10000, 'app ASS renderer');
    const renderer = smoke.getRenderer(1);
    window.__assSmokeRenderer = renderer;
    await renderer.ready;
    video.currentTime = 1.5;
    await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 500));
    video.pause();
    await renderer.renderAt(1.5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const canvas = renderer.canvas;
    const rect = canvas.getBoundingClientRect();
    return {
      sourceUnchanged: video.currentSrc === ${JSON.stringify(sourceUrl)},
      canvasAttached: canvas.parentElement === video.parentElement,
      canvasClass: canvas.className,
      canvasSize: [canvas.width, canvas.height],
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ready: true,
      selectedStreamIndex: selected.streamIndex,
      selectorValue: selector.value,
      selectorOptions: Array.from(selector.options, (option) => option.textContent),
      menuStayedOpen,
      statusText: document.getElementById('vobSubTrackStatus1').textContent
    };
  })()`);

  const rect = result.rect;
  const image = await win.webContents.capturePage({
    x: Math.max(0, Math.floor(rect.x)),
    y: Math.max(0, Math.floor(rect.y)),
    width: Math.max(1, Math.floor(rect.width)),
    height: Math.max(1, Math.floor(rect.height))
  });
  const screenshotPath = path.join(os.tmpdir(), 'dual-video-sync-ass-smoke.png');
  fs.writeFileSync(screenshotPath, image.toPNG());
  const bitmap = image.toBitmap();
  let coloredPixels = 0;
  for (let index = 0; index < bitmap.length; index += 4) {
    const blue = bitmap[index];
    const green = bitmap[index + 1];
    const red = bitmap[index + 2];
    if (red > 60 || green > 60 || blue > 60) coloredPixels += 1;
  }
  if (!result.sourceUnchanged) throw new Error('ASS rendering replaced or transcoded the video source.');
  if (result.selectedStreamIndex !== track.streamIndex || result.selectorValue !== String(track.streamIndex)) throw new Error('English ASS was not selected by default.');
  if (!result.selectorOptions.some((option) => option.includes('ASS')) || !result.menuStayedOpen) throw new Error('The ASS track selector was not usable.');
  if (!result.statusText.startsWith('Ready:')) throw new Error(`The ASS readiness status was not shown: ${result.statusText}`);
  if (!result.canvasAttached || !result.canvasClass.includes('ass-subtitle-canvas')) throw new Error('The ASS canvas was not attached over the video.');
  if (result.canvasSize[0] < 1 || result.canvasSize[1] < 1) throw new Error('The ASS canvas was not sized.');
  if (coloredPixels < 500) throw new Error(`The libass canvas did not visibly render the styled script (${coloredPixels} colored pixels).`);
  const relevantConsoleErrors = consoleErrors.filter((message) => !/Electron Security Warning/.test(message));
  if (relevantConsoleErrors.length > 0) {
    throw new Error(`Renderer console errors: ${relevantConsoleErrors.join(' | ')}`);
  }

  const replacementUrl = pathToFileURL(replacementPath).href;
  const replacementResult = await win.webContents.executeJavaScript(`(async () => {
    const waitUntil = async (predicate, timeoutMs, label) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for ' + label);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const smoke = window.__dvsVobSubSmoke;
    const video = document.getElementById('video1');
    const previousRenderer = smoke.getRenderer(1);
    const previousCanvas = previousRenderer.canvas;
    await smoke.loadSource(video, ${JSON.stringify(replacementUrl)}, 'video1', ${JSON.stringify(replacementPath)}, {
      persist: false,
      skipMetadataProbe: true
    });
    const disposedImmediately = smoke.getRenderer(1) === null && !previousCanvas.isConnected;
    await new Promise((resolve, reject) => {
      if (video.readyState >= 1) return resolve();
      const timeout = setTimeout(() => reject(new Error('Replacement video metadata did not load')), 10000);
      video.addEventListener('loadedmetadata', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    const selected = smoke.prepareTracks('video1', ${JSON.stringify(inspected)}, ${JSON.stringify(replacementPath)});
    await smoke.selectTrack(1, selected.streamIndex);
    await waitUntil(() => smoke.getRenderer(1), 10000, 'replacement ASS renderer');
    const replacementRenderer = smoke.getRenderer(1);
    await replacementRenderer.ready;
    return {
      disposedImmediately,
      rendererReplaced: replacementRenderer !== previousRenderer,
      sourceChanged: video.currentSrc === ${JSON.stringify(replacementUrl)},
      statusText: document.getElementById('vobSubTrackStatus1').textContent
    };
  })()`);
  if (!replacementResult.disposedImmediately || !replacementResult.rendererReplaced || !replacementResult.sourceChanged) {
    throw new Error(`Replacing a video reused its previous ASS renderer: ${JSON.stringify(replacementResult)}`);
  }
  if (!replacementResult.statusText.startsWith('Ready:')) {
    throw new Error(`Replacement ASS track did not become ready: ${replacementResult.statusText}`);
  }

  const externalAssPath = path.join(fixtureDir, 'full-ass.ass');
  const externalResult = await win.webContents.executeJavaScript(`(async () => {
    const smoke = window.__dvsVobSubSmoke;
    const previousRenderer = smoke.getRenderer(1);
    await smoke.applyFile(1, ${JSON.stringify(extracted.content)}, ${JSON.stringify(externalAssPath)}, 'ass', { persist: false });
    const renderer = smoke.getRenderer(1);
    if (!renderer || renderer === previousRenderer) throw new Error('Standalone ASS did not replace the embedded renderer.');
    await renderer.ready;
    await renderer.renderAt(1.5);
    return {
      canvasAttached: renderer.canvas.parentElement === document.getElementById('video1').parentElement,
      selectorValue: document.getElementById('vobSubTrackSelect1').value,
      statusText: document.getElementById('vobSubTrackStatus1').textContent
    };
  })()`);
  if (!externalResult.canvasAttached || externalResult.selectorValue !== '' || !externalResult.statusText.startsWith('Ready: ASS')) {
    throw new Error(`Standalone ASS/SSA loading failed: ${JSON.stringify(externalResult)}`);
  }

  await win.webContents.executeJavaScript('window.__dvsVobSubSmoke.getRenderer(1)?.dispose()');
  console.log(JSON.stringify({ ok: true, track, fontCount: extracted.fonts.length, coloredPixels, screenshotPath, replacementResult, externalResult, ...result }));
  win.destroy();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

app.whenReady()
  .then(runSmoke)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
