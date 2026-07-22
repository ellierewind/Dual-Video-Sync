const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

async function run() {
  const videoPath = process.argv[2];
  if (!videoPath) throw new Error('Pass an HDR video path to the smoke test');
  const requestedTime = Number(process.argv[3] || 600);
  const requestedNits = Math.max(25, Math.min(400, Number(process.argv[4] || 55)));

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await window.loadFile(path.join(__dirname, '..', 'index.html'));
  const videoUrl = pathToFileURL(path.resolve(videoPath)).href;
  const offState = await window.webContents.executeJavaScript(`(async () => {
    const waitUntil = async (predicate, timeout, label) => {
      const started = performance.now();
      while (!predicate()) {
        if (performance.now() - started > timeout) throw new Error('Timed out waiting for ' + label);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    window.__hdrSmokeOriginalSettings = {
      enabled: localStorage.getItem('dvs:hdrToneMapping:enabled'),
      nits: localStorage.getItem('dvs:hdrToneMapping:nits')
    };
    await waitUntil(() => window.hdrToneMapping?.renderers?.length, 10000, 'HDR manager');
    window.hdrToneMapping.setEnabled(false, { persist: false });
    const video = document.getElementById('video1');
    video.src = ${JSON.stringify(videoUrl)};
    video.load();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out loading HDR video')), 30000);
      video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
      video.addEventListener('error', () => { clearTimeout(timer); reject(new Error(video.error?.message || 'Video load failed')); }, { once: true });
    });
    const seekTime = Math.max(0, Math.min(${JSON.stringify(requestedTime)}, Math.max(0, video.duration - 1)));
    if (seekTime > 0) {
      video.currentTime = seekTime;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out seeking HDR video')), 30000);
        video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    window.hdrToneMapping.setVideoMetadata(1, {
      transfer: 'smpte2084', primaries: 'bt2020', matrix: 'bt2020nc', bitDepth: 10, isHdr: true
    });
    const renderer = window.hdrToneMapping.renderers[0];
    return {
      canvasHidden: renderer.canvas.hidden,
      canvasDisplay: getComputedStyle(renderer.canvas).display,
      videoOpacity: getComputedStyle(video).opacity,
      currentTime: video.currentTime
    };
  })()`, true);

  const nativeScreenshotPath = path.join(app.getPath('temp'), 'dual-video-sync-hdr-native.png');
  await fs.writeFile(nativeScreenshotPath, (await window.webContents.capturePage()).toPNG());

  const result = await window.webContents.executeJavaScript(`(async () => {
    const waitUntil = async (predicate, timeout, label) => {
      const started = performance.now();
      while (!predicate()) {
        if (performance.now() - started > timeout) throw new Error('Timed out waiting for ' + label);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const toggle = document.getElementById('hdrConvert1');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    const nits = document.getElementById('hdrNits1');
    nits.value = ${JSON.stringify(String(requestedNits))};
    nits.dispatchEvent(new Event('change', { bubbles: true }));
    await waitUntil(() => {
      const renderer = window.hdrToneMapping.renderers[0];
      return renderer?.error || renderer?.metrics?.renderedFrames > 0;
    }, 30000, 'first tone-mapped frame');
    const renderer = window.hdrToneMapping.renderers[0];
    renderer.gl?.finish();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      webgl2: !!renderer.gl,
      status: document.getElementById('hdrStatus1')?.textContent,
      controlsSynchronized: document.getElementById('hdrConvert2')?.checked === true
        && document.getElementById('hdrNits2')?.value === ${JSON.stringify(String(requestedNits))},
      error: renderer.error?.message || null,
      videoOpacity: getComputedStyle(renderer.video).opacity,
      canvasDisplay: getComputedStyle(renderer.canvas).display,
      metrics: window.hdrToneMapping.getMetrics()
    };
  })()`, true);

  const toneMappedScreenshotPath = path.join(app.getPath('temp'), `dual-video-sync-hdr-tone-mapped-${requestedNits}.png`);
  await fs.writeFile(toneMappedScreenshotPath, (await window.webContents.capturePage()).toPNG());

  window.showInactive();
  const performanceResult = await window.webContents.executeJavaScript(`(async () => {
    const video = document.getElementById('video1');
    const renderer = window.hdrToneMapping.renderers[0];
    await new Promise((resolve) => setTimeout(resolve, 250));
    video.muted = true;
    const framesBeforePlayback = renderer.metrics.renderedFrames;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    video.pause();
    const playbackFrames = renderer.metrics.renderedFrames - framesBeforePlayback;
    const seekStarted = performance.now();
    let immediatePausedSeekRefreshes = 0;
    for (let index = 0; index < 5; index += 1) {
      const framesBeforeSeek = renderer.metrics.renderedFrames;
      video.currentTime = Math.min(video.duration - 1, video.currentTime + 5);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out during repeated seek test')), 10000);
        video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (renderer.metrics.renderedFrames > framesBeforeSeek) immediatePausedSeekRefreshes += 1;
      const waitStarted = performance.now();
      while (renderer.metrics.renderedFrames === framesBeforeSeek) {
        if (performance.now() - waitStarted > 5000) throw new Error('Tone-mapped frame did not follow seek');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return {
      playbackFrames,
      immediatePausedSeekRefreshes,
      fiveSeekTimeMs: performance.now() - seekStarted,
      metrics: window.hdrToneMapping.getMetrics()[0]
    };
  })()`, true);

  console.log(JSON.stringify({
    ...result, offState, performanceResult, nativeScreenshotPath, toneMappedScreenshotPath
  }, null, 2));
  await window.webContents.executeJavaScript(`(() => {
    window.hdrToneMapping.setEnabled(false, { persist: false });
    const original = window.__hdrSmokeOriginalSettings;
    for (const [name, key] of [['enabled', 'dvs:hdrToneMapping:enabled'], ['nits', 'dvs:hdrToneMapping:nits']]) {
      if (original[name] === null) localStorage.removeItem(key);
      else localStorage.setItem(key, original[name]);
    }
  })()`);
  window.destroy();
  const offStateWorks = offState.canvasHidden && offState.canvasDisplay === 'none' && offState.videoOpacity === '1';
  const onStateWorks = result.videoOpacity === '1' && result.canvasDisplay === 'block';
  const performanceWorks = performanceResult.playbackFrames >= 50
    && performanceResult.immediatePausedSeekRefreshes === 5
    && performanceResult.metrics.maxSubmitTimeMs < 10;
  if (!result.webgl2 || result.error || !result.controlsSynchronized || !offStateWorks || !onStateWorks
      || !performanceWorks || result.metrics[0].renderedFrames < 1) {
    throw new Error('HDR WebGL smoke test did not render a frame');
  }
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
