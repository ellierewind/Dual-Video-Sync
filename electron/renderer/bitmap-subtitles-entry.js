import { createAutoSubtitleRenderer, initWasm } from 'libbitsub';

const ready = initWasm();

window.bitmapSubtitleAPI = {
  ready,
  createRenderer(options) {
    // libbitsub's inline worker cannot fetch WASM from Electron's file: origin.
    // Constructing without Worker selects its immediate main-thread WASM path
    // instead of delaying subtitle startup for the worker's 30-second timeout.
    const WorkerConstructor = globalThis.Worker;
    try {
      globalThis.Worker = undefined;
      return createAutoSubtitleRenderer(options);
    } finally {
      globalThis.Worker = WorkerConstructor;
    }
  }
};

window.dispatchEvent(new CustomEvent('bitmap-subtitles-ready'));
