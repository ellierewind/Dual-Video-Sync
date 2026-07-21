const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { BitmapSubtitleService } = require('./bitmap-subtitles');
const { DynamicAudioService } = require('./dynamic-audio');

const fixturePath = process.argv.find((value) => value.toLowerCase().endsWith('.mkv'));
const resultPath = process.argv.find((value) => value.toLowerCase().endsWith('.json'));
if (!fixturePath) throw new Error('Usage: electron dynamic-audio.smoke.js <fixture.mkv> [result.json]');

const absoluteFixturePath = path.resolve(fixturePath);
const sourceUrl = pathToFileURL(absoluteFixturePath).toString();
const userDataPath = path.join(os.tmpdir(), 'dvs-converted-audio-smoke-user-data');
fs.rmSync(userDataPath, { recursive: true, force: true });
app.setPath('userData', userDataPath);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const metadataService = new BitmapSubtitleService(app);
const audioService = new DynamicAudioService(app);
const progressEvents = [];

function writeResult(value) {
  if (resultPath) fs.writeFileSync(path.resolve(resultPath), JSON.stringify(value, null, 2));
}

async function run() {
  ipcMain.handle('audio:prepare-track', async (event, { filePath, streamIndex, requestId }) => {
    const inspected = await metadataService.inspectVideo(filePath);
    const track = inspected.audioTracks.find((candidate) => candidate.streamIndex === Number(streamIndex));
    if (!track) throw new Error('The requested audio track was not found.');
    return {
      ...await audioService.prepareTrack(filePath, track, (progress) => {
        progressEvents.push({ requestId, progress });
        if (!event.sender.isDestroyed()) event.sender.send('audio:conversion-progress', { requestId, progress });
      }),
      track
    };
  });
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

  const metadata = await metadataService.inspectVideo(absoluteFixturePath);
  if (metadata.audioTracks.length < 2) throw new Error('The smoke fixture needs at least two audio tracks.');

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.webContents.setAudioMuted(true);
  const rendererMessages = [];
  win.webContents.on('console-message', (details) => rendererMessages.push(`${details.level}: ${details.message}`));
  await win.loadFile(path.join(__dirname, '..', 'index.html'), { query: { 'dynamic-audio-smoke': '1' } });

  const result = await win.webContents.executeJavaScript(`(async () => {
    const waitUntil = async (predicate, timeoutMs, label) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(window.__dvsDynamicAudioSmoke?.getPlayerState(1)));
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    };
    await waitUntil(() => window.__dvsDynamicAudioSmoke?.getPlayerState(1), 10000, 'converted audio controller');
    localStorage.removeItem('dvs:audio1:choice');
    const smoke = window.__dvsDynamicAudioSmoke;
    const video = document.getElementById('video1');
    const tracks = ${JSON.stringify(metadata.audioTracks)};
    const selected = ${JSON.stringify(metadata.selectedAudioTrack)};
    smoke.setVideoPath(1, ${JSON.stringify(absoluteFixturePath)});
    video.src = ${JSON.stringify(sourceUrl)};
    video.load();
    // Match real startup ordering: audio configuration begins immediately
    // after video.load(), before the asynchronous emptied event settles.
    const prepared = smoke.prepareTracks('video1', { audioTracks: tracks, selectedAudioTrack: selected }, ${JSON.stringify(absoluteFixturePath)});
    smoke.configureTrack('video1', prepared, ${JSON.stringify(absoluteFixturePath)});
    await waitUntil(() => video.readyState >= 1, 10000, 'video metadata');
    await waitUntil(() => smoke.getPlayerState(1)?.ready, 30000, 'whole-track conversion');
    const initialState = smoke.getPlayerState(1);
    await video.play();
    await waitUntil(() => video.currentTime > 1 && smoke.getPlayerState(1)?.audioCurrentTime > 0.5, 10000, 'converted audio playback');
    const playingState = smoke.getPlayerState(1);
    const playingDrift = Math.abs(playingState.videoCurrentTime - playingState.audioCurrentTime);
    const sustainedTarget = video.currentTime + 8;
    await waitUntil(() => video.currentTime >= sustainedTarget, 15000, 'sustained converted audio playback');
    const sustainedState = smoke.getPlayerState(1);
    const sustainedDrift = Math.abs(sustainedState.videoCurrentTime - sustainedState.audioCurrentTime);

    video.pause();
    const cacheKeyBeforeSeek = smoke.getPlayerState(1).cacheKey;
    video.currentTime = 5;
    await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
    await video.play();
    await waitUntil(() => smoke.getPlayerState(1)?.audioCurrentTime > 5.2, 5000, 'instant seek in converted audio');
    const seekState = smoke.getPlayerState(1);
    const seekDrift = Math.abs(seekState.videoCurrentTime - seekState.audioCurrentTime);

    const speed = document.getElementById('speedSelect1');
    speed.value = '1.5';
    speed.dispatchEvent(new Event('change', { bubbles: true }));
    await waitUntil(() => Math.abs(smoke.getPlayerState(1)?.audioPlaybackRate - 1.5) < 0.001, 3000, 'audio speed');
    const volume = document.getElementById('volumeSlider1');
    volume.value = '0.35';
    volume.dispatchEvent(new Event('input', { bubbles: true }));

    const secondTrack = tracks.find((track) => track.streamIndex !== prepared.streamIndex);
    await smoke.selectTrack(1, secondTrack.streamIndex);
    await waitUntil(() => {
      const state = smoke.getPlayerState(1);
      return state?.ready && state.track?.streamIndex === secondTrack.streamIndex && state.cacheKey !== cacheKeyBeforeSeek;
    }, 30000, 'second whole-track conversion');
    const switchedState = smoke.getPlayerState(1);
    video.pause();
    return {
      sourceUnchanged: video.currentSrc === ${JSON.stringify(sourceUrl)},
      selectedByDefault: prepared?.streamIndex ?? null,
      initialState,
      playingState,
      playingDrift,
      sustainedState,
      sustainedDrift,
      cacheKeyBeforeSeek,
      seekState,
      seekDrift,
      switchedState
    };
  })()`);

  if (!result.sourceUnchanged) throw new Error('Converted audio replaced the original video source.');
  if (result.selectedByDefault !== metadata.selectedAudioTrack.streamIndex) throw new Error('English/default audio was not selected.');
  if (!result.initialState.source.toLowerCase().endsWith('.wav')) throw new Error(`Converted source is not WAV: ${result.initialState.source}`);
  if (result.seekState.cacheKey !== result.cacheKeyBeforeSeek) throw new Error('Seeking reconverted or replaced the cached audio file.');
  if (result.playingDrift > 0.65 || result.sustainedDrift > 0.65 || result.seekDrift > 0.65) throw new Error(`Converted audio drifted: ${result.playingDrift}, ${result.sustainedDrift}, ${result.seekDrift}`);
  if (result.sustainedState.waitingEvents !== result.playingState.waitingEvents || result.sustainedState.stalledEvents !== result.playingState.stalledEvents) throw new Error('Converted audio stalled during sustained playback.');

  const selectedTrack = metadata.audioTracks.find((track) => track.streamIndex === result.selectedByDefault);
  const cacheStarted = Date.now();
  const cachedResult = await audioService.prepareTrack(absoluteFixturePath, selectedTrack);
  const cacheReuseMs = Date.now() - cacheStarted;
  if (!cachedResult.cached || cacheReuseMs > 1000) throw new Error(`Converted audio cache was not reused quickly: ${cacheReuseMs}ms`);

  const output = { ok: true, rendererMessages, metadata, progressEvents, cacheReuseMs, ...result };
  writeResult(output);
  console.log(JSON.stringify({
    ok: true,
    defaultCodec: result.initialState.track.codec,
    output: result.initialState.source,
    progressEvents: progressEvents.length,
    cacheReuseMs,
    playingDrift: result.playingDrift,
    sustainedDrift: result.sustainedDrift,
    seekDrift: result.seekDrift,
    waitingEvents: result.sustainedState.waitingEvents,
    stalledEvents: result.sustainedState.stalledEvents
  }, null, 2));
  win.destroy();
  audioService.dispose();
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    writeResult({ ok: false, error: error?.stack || String(error) });
    console.error(error);
    audioService.dispose();
    app.exit(1);
  });
