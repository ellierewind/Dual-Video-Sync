import JASSUB from 'jassub';
import defaultFont from 'jassub/dist/default.woff2';
import wasmUrl from 'jassub/dist/wasm/jassub-worker.wasm';
import modernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm';

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function createRenderer(options) {
  const fonts = (Array.isArray(options.fonts) ? options.fonts : [])
    .map(toUint8Array)
    .filter(Boolean);
  const fallbackFont = toUint8Array(defaultFont);
  const instance = new JASSUB({
    video: options.video,
    subContent: String(options.subContent || ''),
    workerUrl: new URL('./jassub-worker.js', import.meta.url).href,
    wasmUrl,
    modernWasmUrl,
    fonts,
    availableFonts: { 'Liberation Sans': fallbackFont },
    defaultFont: 'Liberation Sans',
    queryFonts: 'local',
    debug: !!options.debug
  });
  const canvas = instance._canvas;
  canvas.classList.add('ass-subtitle-canvas', 'bitmap-subtitle-canvas');

  let disposed = false;
  const applyDisplaySettings = (settings = {}) => {
    const scale = Number.isFinite(Number(settings.scale)) ? Number(settings.scale) : 1;
    const opacity = Number.isFinite(Number(settings.opacity)) ? Number(settings.opacity) : 1;
    canvas.style.opacity = String(Math.max(0, Math.min(1, opacity)));
    canvas.style.transform = `scale(${Math.max(0.1, Math.min(3, scale))})`;
  };
  applyDisplaySettings(options.displaySettings);

  const ready = instance.ready.then(async () => {
    await instance.resize(true);
    if (!disposed) options.onEvent?.({ type: 'loaded' });
  }).catch((error) => {
    if (!disposed) options.onEvent?.({ type: 'error', error });
    throw error;
  });

  return {
    canvas,
    ready,
    renderAt(mediaTime) {
      return instance.manualRender({
        expectedDisplayTime: performance.now(),
        width: options.video.videoWidth || options.video.clientWidth,
        height: options.video.videoHeight || options.video.clientHeight,
        mediaTime: Number(mediaTime) || 0
      }, true);
    },
    setDisplaySettings: applyDisplaySettings,
    dispose() {
      if (disposed) return;
      disposed = true;
      instance.destroy().catch(() => { });
    }
  };
}

window.assSubtitleAPI = { createRenderer };
window.dispatchEvent(new CustomEvent('ass-subtitles-ready'));
