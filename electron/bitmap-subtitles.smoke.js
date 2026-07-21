const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');
const { BitmapSubtitleService } = require('./bitmap-subtitles');

app.disableHardwareAcceleration();

const resultPathArgument = process.argv.find((value) => value.toLowerCase().endsWith('.json'));
const resultPath = resultPathArgument ? path.resolve(resultPathArgument) : null;
if (resultPath) {
  const smokeUserDataPath = path.join(path.dirname(resultPath), 'electron-smoke-user-data');
  fs.rmSync(smokeUserDataPath, { recursive: true, force: true });
  app.setPath('userData', smokeUserDataPath);
}

function writeResult(value) {
  if (!resultPath) return;
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function run() {
  const fixturePath = process.argv.find((value) => value.toLowerCase().endsWith('.mkv'));
  if (!fixturePath || !fs.existsSync(fixturePath)) {
    throw new Error('Pass an existing MKV fixture path to the smoke test.');
  }

  const absoluteFixturePath = path.resolve(fixturePath);
  const service = new BitmapSubtitleService(app);
  const inspected = await service.inspectVideo(absoluteFixturePath);
  if (!inspected.selectedVobSubTrack) throw new Error('The fixture has no VobSub track.');
  const extracted = await service.loadTrack(absoluteFixturePath, inspected.selectedVobSubTrack.streamIndex);
  const subtitleBase64 = Buffer.from(extracted.content).toString('base64');
  const sourceUrl = pathToFileURL(absoluteFixturePath).toString();

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'), { query: { 'vobsub-smoke': '1' } });

  const result = await win.webContents.executeJavaScript(`(async () => {
    const waitUntil = async (predicate, timeoutMs, label) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for ' + label);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    await waitUntil(() => window.bitmapSubtitleAPI, 10000, 'libbitsub module');
    await window.bitmapSubtitleAPI.ready;

    const uiTracks = [
      { streamIndex: 1, codec: 'dvd_subtitle', language: 'jpn', title: 'Japanese', forced: true, default: true },
      { streamIndex: 2, codec: 'dvd_subtitle', language: 'eng', title: 'English SDH', forced: false, default: false }
    ];
    const smokeApi = window.__dvsVobSubSmoke;
    smokeApi.setVideoPath(1, ${JSON.stringify(absoluteFixturePath)});
    smokeApi.prepareTracks('video1', { vobSubTracks: uiTracks, selectedVobSubTrack: uiTracks[1] }, ${JSON.stringify(absoluteFixturePath)});
    smokeApi.setStatus(1, 'loading', 'Loading 2. English — English SDH…');
    const selector = document.getElementById('vobSubTrackSelect1');
    const trackRow = document.getElementById('vobSubTrackRow1');
    const loadingIndicator = document.getElementById('vobSubIndicator1');
    const settings = document.getElementById('settings1');
    document.getElementById('settingsToggle1').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    selector.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const uiLoadingState = {
      selectorValue: selector.value,
      options: Array.from(selector.options, (option) => option.textContent),
      optionValues: Array.from(selector.options, (option) => option.value),
      menuStayedOpenAfterSelectorClick: settings.classList.contains('open'),
      rowVisible: !trackRow.hidden,
      indicatorVisible: !loadingIndicator.hidden,
      indicatorText: document.getElementById('vobSubIndicatorText1').textContent
    };
    await smokeApi.selectTrack(1, 1);
    const changedStreamIndex = smokeApi.getTrack(1)?.streamIndex ?? null;
    const rememberedTrack = smokeApi.prepareTracks(
      'video1',
      { vobSubTracks: uiTracks, selectedVobSubTrack: uiTracks[1] },
      ${JSON.stringify(absoluteFixturePath)}
    );
    smokeApi.setStatus(1, 'ready', 'Ready: 1. Japanese');
    const uiReadyState = {
      changedStreamIndex,
      rememberedStreamIndex: rememberedTrack?.streamIndex ?? null,
      selectorValue: selector.value,
      statusText: document.getElementById('vobSubTrackStatus1').textContent,
      indicatorHidden: loadingIndicator.hidden
    };

    const video = document.getElementById('video1');
    video.muted = true;
    video.src = ${JSON.stringify(sourceUrl)};
    video.load();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video metadata did not load')), 10000);
      video.addEventListener('loadedmetadata', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });

    const binary = atob(${JSON.stringify(subtitleBase64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    let renderer;
    const rendererEvents = [];
    const loaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('VobSub renderer did not load: ' + JSON.stringify(rendererEvents))), 10000);
      renderer = window.bitmapSubtitleAPI.createRenderer({
        video,
        subContent: bytes.buffer,
        fileName: ${JSON.stringify(extracted.fileName)},
        debug: true,
        onEvent: (event) => {
          rendererEvents.push(event.type + (event.type === 'warning' ? ':' + event.warning?.code : ''));
          if (event.type === 'loaded') {
            clearTimeout(timeout);
            resolve(event.metadata);
          } else if (event.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(event.error?.message || 'VobSub renderer error'));
          }
        }
      });
    });
    const metadata = await loaded;
    const canvas = renderer.canvas;
    video.currentTime = 49;
    await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
    await waitUntil(() => renderer.getCurrentCueMetadata() !== null, 10000, 'active VobSub cue');
    await waitUntil(() => {
      const info = renderer.getLastRenderInfo();
      return info?.status === 'rendered' && info.compositionCount > 0;
    }, 10000, 'rendered VobSub bitmap');
    const renderedCue = renderer.getCurrentCueMetadata();
    const renderInfo = renderer.getLastRenderInfo();
    const output = {
      sourceUnchanged: video.currentSrc === ${JSON.stringify(sourceUrl)},
      sourceUrl: video.currentSrc,
      canvasAttached: canvas instanceof HTMLCanvasElement && canvas.parentElement === video.parentElement,
      canvasSize: [canvas?.width || 0, canvas?.height || 0],
      renderedCue,
      renderInfo,
      uiLoadingState,
      uiReadyState,
      metadata
    };
    renderer.dispose();
    return output;
  })()`);

  if (resultPath) {
    await win.webContents.executeJavaScript(`(() => {
      const overlay = document.getElementById('overlayPlayer');
      overlay.style.visibility = 'hidden';
      overlay.style.zIndex = '-1';
      const settings = document.getElementById('settings1');
      settings.classList.add('open');
      settings.querySelector('.dropdown-menu').style.display = 'block';
      window.__dvsVobSubSmoke.setStatus(1, 'loading', 'Loading 2. English — English SDH…');
      const indicator = document.getElementById('vobSubIndicator1');
      indicator.hidden = false;
      indicator.style.display = 'inline-flex';
      document.body.classList.remove('idle');
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    result.uiLayout = await win.webContents.executeJavaScript(`(() => {
      const summarize = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        indicator: summarize(document.getElementById('vobSubIndicator1')),
        menu: summarize(document.querySelector('#settings1 .dropdown-menu')),
        selector: summarize(document.getElementById('vobSubTrackSelect1'))
      };
    })()`);
  }

  if (!result.sourceUnchanged) throw new Error('The video source was replaced instead of remaining the original MKV.');
  if (!result.canvasAttached) throw new Error('The VobSub canvas was not attached over the video.');
  if (result.uiLoadingState.selectorValue !== '2') throw new Error('English was not selected by default in the VobSub track control.');
  if (!result.uiLoadingState.menuStayedOpenAfterSelectorClick) throw new Error('Clicking the VobSub selector closed its settings menu.');
  if (result.uiLoadingState.optionValues.length !== 3 || new Set(result.uiLoadingState.optionValues).size !== 3) throw new Error('The VobSub selector contains missing or duplicate options.');
  if (!result.uiLoadingState.rowVisible || !result.uiLoadingState.indicatorVisible) throw new Error('The VobSub selector or loading indicator was not visible.');
  if (result.uiReadyState.changedStreamIndex !== 1 || result.uiReadyState.rememberedStreamIndex !== 1 || result.uiReadyState.selectorValue !== '1') throw new Error('A manual VobSub track change was not applied and remembered.');
  if (!result.uiReadyState.indicatorHidden) throw new Error('The VobSub loading indicator did not clear after readiness.');
  if (!result.uiLayout?.indicator.visible || !result.uiLayout?.menu.visible || !result.uiLayout?.selector.visible) throw new Error('The VobSub loading badge or selector menu did not render visibly.');
  writeResult({ ok: true, ...result });
  console.log(JSON.stringify(result));
  win.destroy();
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    writeResult({ ok: false, error: error?.stack || String(error) });
    console.error(error);
    app.exit(1);
  });
