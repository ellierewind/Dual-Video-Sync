(function initializeHdrToneMappingModule() {
  'use strict';

  const STORAGE_ENABLED = 'dvs:hdrToneMapping:enabled';
  const STORAGE_NITS = 'dvs:hdrToneMapping:nits';
  const DEFAULT_NITS = 125;
  const MIN_NITS = 25;
  const MAX_NITS = 400;
  const PLAYER_IDS = ['video1', 'video2'];

  const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 uv;

void main() {
  vec2 positions[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
  );
  vec2 uvs[3] = vec2[3](
    vec2(0.0, 0.0),
    vec2(2.0, 0.0),
    vec2(0.0, 2.0)
  );
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
  uv = uvs[gl_VertexID];
}`;

  // This is the MPC Video Renderer PQ -> Hable -> BT.709 sequence, ported to GLSL.
  const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
uniform float targetNits;
uniform float frameIndex;
in vec2 uv;
out vec4 outputColor;

const float ST2084_M1 = 2610.0 / (4096.0 * 4.0);
const float ST2084_M2 = (2523.0 / 4096.0) * 128.0;
const float ST2084_C1 = 3424.0 / 4096.0;
const float ST2084_C2 = (2413.0 / 4096.0) * 32.0;
const float ST2084_C3 = (2392.0 / 4096.0) * 32.0;

vec3 st2084ToLinear(vec3 value, float luminanceScale) {
  vec3 powered = pow(clamp(value, 0.0, 1.0), vec3(1.0 / ST2084_M2));
  vec3 numerator = max(powered - vec3(ST2084_C1), vec3(0.0));
  vec3 denominator = vec3(ST2084_C2) - ST2084_C3 * powered;
  return pow(numerator / denominator, vec3(1.0 / ST2084_M1)) * luminanceScale;
}

vec3 hable(vec3 value) {
  const float a = 0.15;
  const float b = 0.50;
  const float c = 0.10;
  const float d = 0.20;
  const float e = 0.02;
  const float f = 0.30;
  return ((value * (a * value + vec3(c * b)) + vec3(d * e)) /
          (value * (a * value + vec3(b)) + vec3(d * f))) - vec3(e / f);
}

vec3 bt2020ToBt709(vec3 value) {
  return vec3(
     1.660491 * value.r - 0.587641 * value.g - 0.072850 * value.b,
    -0.124550 * value.r + 1.132900 * value.g - 0.008349 * value.b,
    -0.018151 * value.r - 0.100579 * value.g + 1.118730 * value.b
  );
}

float interleavedGradientNoise(vec2 position) {
  return fract(52.9829189 * fract(dot(position, vec2(0.06711056, 0.00583715)))) - 0.5;
}

void main() {
  vec3 pqBt2020 = texture(sourceTexture, uv).rgb;
  vec3 linearBt2020 = st2084ToLinear(pqBt2020, 10000.0 / targetNits);
  vec3 mappedBt2020 = hable(linearBt2020) / hable(vec3(4.8));
  vec3 linearBt709 = bt2020ToBt709(mappedBt2020);
  vec3 encodedSrgb = pow(clamp(linearBt709, 0.0, 1.0), vec3(1.0 / 2.2));
  float dither = interleavedGradientNoise(gl_FragCoord.xy + vec2(frameIndex, 0.0)) / 255.0;
  outputColor = vec4(clamp(encodedSrgb + vec3(dither), 0.0, 1.0), 1.0);
}`;

  function clampNits(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_NITS;
    return Math.round(Math.max(MIN_NITS, Math.min(MAX_NITS, number)) / 5) * 5;
  }

  function readBoolean(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value === 'true';
    } catch {
      return fallback;
    }
  }

  function readNits() {
    try {
      return clampNits(localStorage.getItem(STORAGE_NITS) || DEFAULT_NITS);
    } catch {
      return DEFAULT_NITS;
    }
  }

  function writeSetting(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { }
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'Shader compilation failed';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createProgram(gl) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'Shader link failed';
      gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  class VideoToneMapper {
    constructor(video, playerNumber, manager) {
      this.video = video;
      this.playerNumber = playerNumber;
      this.manager = manager;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'hdr-tone-map-canvas';
      this.canvas.hidden = true;
      this.video.insertAdjacentElement('afterend', this.canvas);
      this.enabled = false;
      this.active = false;
      this.initialized = false;
      this.frameCallbackId = null;
      this.frameIndex = 0;
      this.isHdr = false;
      this.zeroCopy = false;
      this.lastPresentedFrames = null;
      this.metrics = {
        renderedFrames: 0,
        callbackFrameGaps: 0,
        callbackLateFrames: 0,
        maxCallbackLatenessMs: 0,
        maxSubmitTimeMs: 0,
        lastMediaTime: null
      };
      this.resizeObserver = new ResizeObserver(() => {
        this.updateLayout();
        this.renderCurrentFrame();
      });
      if (this.video.parentElement) this.resizeObserver.observe(this.video.parentElement);
      this.video.addEventListener('loadedmetadata', () => this.updateLayout());
      this.video.addEventListener('seeked', () => {
        if (!this.active || !this.video.paused) return;
        this.renderCurrentFrame();
        requestAnimationFrame(() => {
          if (this.active && this.video.paused && !this.video.seeking) this.renderCurrentFrame();
        });
      });
      this.video.addEventListener('emptied', () => this.deactivate());
    }

    setVideoColor(videoColor) {
      this.videoColor = videoColor || null;
      this.isHdr = !!videoColor?.isHdr;
      this.toneMapSupported = String(videoColor?.transfer || '').toLowerCase() === 'smpte2084';
      this.error = null;
      this.applyEnabledState();
      this.manager.updateControls();
    }

    initialize() {
      if (this.initialized) return;
      const gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
        desynchronized: true,
        powerPreference: 'high-performance'
      });
      if (!gl) throw new Error('WebGL2 is unavailable');
      const program = createProgram(gl);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.disable(gl.DITHER);
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'sourceTexture'), 0);
      gl.bindVertexArray(gl.createVertexArray());
      this.gl = gl;
      this.program = program;
      this.texture = texture;
      this.targetNitsLocation = gl.getUniformLocation(program, 'targetNits');
      this.frameIndexLocation = gl.getUniformLocation(program, 'frameIndex');
      this.initialized = true;
      this.canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.fail(new Error('GPU context was lost'));
      });
    }

    setEnabled(enabled) {
      this.enabled = !!enabled;
      this.applyEnabledState();
    }

    applyEnabledState() {
      if (!this.enabled || !this.isHdr || !this.toneMapSupported) {
        this.deactivate();
        return;
      }
      try {
        this.initialize();
        this.active = true;
        this.updateLayout();
        this.canvas.hidden = false;
        this.video.classList.add('hdr-tone-map-source');
        this.renderCurrentFrame();
        this.scheduleFrame();
      } catch (error) {
        this.fail(error);
      }
      this.manager.updateControls();
    }

    deactivate() {
      this.active = false;
      if (this.frameCallbackId !== null) {
        if (this.frameCallbackKind === 'video' && typeof this.video.cancelVideoFrameCallback === 'function') {
          this.video.cancelVideoFrameCallback(this.frameCallbackId);
        } else if (this.frameCallbackKind === 'animation') {
          cancelAnimationFrame(this.frameCallbackId);
        }
      }
      this.frameCallbackId = null;
      this.frameCallbackKind = null;
      this.canvas.hidden = true;
      this.video.classList.remove('hdr-tone-map-source');
    }

    fail(error) {
      console.error(`HDR tone mapping failed for video ${this.playerNumber}:`, error);
      this.error = error instanceof Error ? error : new Error(String(error));
      this.deactivate();
      this.manager.updateControls();
    }

    updateLayout() {
      const parent = this.video.parentElement;
      if (!parent) return;
      const containerWidth = parent.clientWidth;
      const containerHeight = parent.clientHeight;
      const videoWidth = this.video.videoWidth;
      const videoHeight = this.video.videoHeight;
      if (!containerWidth || !containerHeight || !videoWidth || !videoHeight) return;

      const sourceAspect = videoWidth / videoHeight;
      const containerAspect = containerWidth / containerHeight;
      let displayWidth;
      let displayHeight;
      if (containerAspect > sourceAspect) {
        displayHeight = containerHeight;
        displayWidth = displayHeight * sourceAspect;
      } else {
        displayWidth = containerWidth;
        displayHeight = displayWidth / sourceAspect;
      }

      this.canvas.style.left = `${(containerWidth - displayWidth) / 2}px`;
      this.canvas.style.top = `${(containerHeight - displayHeight) / 2}px`;
      this.canvas.style.width = `${displayWidth}px`;
      this.canvas.style.height = `${displayHeight}px`;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      const pixelWidth = Math.max(1, Math.round(displayWidth * pixelRatio));
      const pixelHeight = Math.max(1, Math.round(displayHeight * pixelRatio));
      if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;
      }
    }

    scheduleFrame() {
      if (!this.active || this.frameCallbackId !== null) return;
      if (typeof this.video.requestVideoFrameCallback !== 'function') {
        this.frameCallbackKind = 'animation';
        this.frameCallbackId = requestAnimationFrame(() => {
          this.frameCallbackId = null;
          this.renderCurrentFrame();
          this.scheduleFrame();
        });
        return;
      }
      this.frameCallbackKind = 'video';
      this.frameCallbackId = this.video.requestVideoFrameCallback((now, metadata) => {
        this.frameCallbackId = null;
        this.recordFrameTiming(now, metadata);
        this.renderCurrentFrame();
        this.scheduleFrame();
      });
    }

    recordFrameTiming(now, metadata) {
      if (!metadata) return;
      if (Number.isFinite(metadata.presentedFrames) && this.lastPresentedFrames !== null) {
        this.metrics.callbackFrameGaps += Math.max(0, metadata.presentedFrames - this.lastPresentedFrames - 1);
      }
      this.lastPresentedFrames = Number.isFinite(metadata.presentedFrames) ? metadata.presentedFrames : this.lastPresentedFrames;
      const lateness = Number.isFinite(metadata.expectedDisplayTime) ? Math.max(0, now - metadata.expectedDisplayTime) : 0;
      if (lateness > 0.5) this.metrics.callbackLateFrames += 1;
      this.metrics.maxCallbackLatenessMs = Math.max(this.metrics.maxCallbackLatenessMs, lateness);
      this.metrics.lastMediaTime = Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : this.metrics.lastMediaTime;
    }

    renderCurrentFrame() {
      if (!this.active || !this.initialized || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (!this.canvas.width || !this.canvas.height) this.updateLayout();
      const started = performance.now();
      try {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.program);
        gl.uniform1f(this.targetNitsLocation, this.manager.displayNits);
        gl.uniform1f(this.frameIndexLocation, this.frameIndex++ % 256);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.flush();
        this.metrics.renderedFrames += 1;
        this.metrics.maxSubmitTimeMs = Math.max(this.metrics.maxSubmitTimeMs, performance.now() - started);
      } catch (error) {
        this.fail(error);
      }
    }

    snapshotMetrics() {
      const playback = typeof this.video.getVideoPlaybackQuality === 'function'
        ? this.video.getVideoPlaybackQuality()
        : null;
      return {
        player: this.playerNumber,
        hdrDetected: this.isHdr,
        zeroCopy: false,
        canvas: `${this.canvas.width}x${this.canvas.height}`,
        ...this.metrics,
        decodedFrames: playback?.totalVideoFrames ?? null,
        droppedFrames: playback?.droppedVideoFrames ?? null
      };
    }
  }

  class HdrToneMappingManager {
    constructor() {
      this.enabled = readBoolean(STORAGE_ENABLED, false);
      this.displayNits = readNits();
      this.renderers = [];
    }

    initialize() {
      this.renderers = PLAYER_IDS.map((id, index) => {
        const video = document.getElementById(id);
        return video ? new VideoToneMapper(video, index + 1, this) : null;
      }).filter(Boolean);
      this.bindControls();
      this.updateControls();
      this.renderers.forEach((renderer) => renderer.setEnabled(this.enabled));
    }

    bindControls() {
      for (const playerNumber of [1, 2]) {
        document.getElementById(`hdrConvert${playerNumber}`)?.addEventListener('change', (event) => {
          this.setEnabled(event.target.checked);
        });
        const input = document.getElementById(`hdrNits${playerNumber}`);
        input?.addEventListener('change', (event) => this.setDisplayNits(event.target.value));
        input?.addEventListener('input', (event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value) && value >= MIN_NITS && value <= MAX_NITS) this.setDisplayNits(value);
        });
      }
      window.addEventListener('storage', (event) => {
        if (event.key === STORAGE_ENABLED) this.setEnabled(event.newValue === 'true', { persist: false });
        if (event.key === STORAGE_NITS) this.setDisplayNits(event.newValue, { persist: false });
      });
    }

    setEnabled(enabled, options = {}) {
      this.enabled = !!enabled;
      if (options.persist !== false) writeSetting(STORAGE_ENABLED, this.enabled);
      this.renderers.forEach((renderer) => renderer.setEnabled(this.enabled));
      this.updateControls();
    }

    setDisplayNits(value, options = {}) {
      this.displayNits = clampNits(value);
      if (options.persist !== false) writeSetting(STORAGE_NITS, this.displayNits);
      this.updateControls();
      this.renderers.forEach((renderer) => renderer.renderCurrentFrame());
    }

    setVideoMetadata(playerNumber, videoColor) {
      this.renderers.find((renderer) => renderer.playerNumber === Number(playerNumber))?.setVideoColor(videoColor);
    }

    swapVideoMetadata() {
      const first = this.renderers.find((renderer) => renderer.playerNumber === 1);
      const second = this.renderers.find((renderer) => renderer.playerNumber === 2);
      if (!first || !second) return;
      const firstColor = first.videoColor;
      first.setVideoColor(second.videoColor);
      second.setVideoColor(firstColor);
    }

    updateControls() {
      for (const playerNumber of [1, 2]) {
        const toggle = document.getElementById(`hdrConvert${playerNumber}`);
        const input = document.getElementById(`hdrNits${playerNumber}`);
        const output = document.getElementById(`hdrNitsValue${playerNumber}`);
        const status = document.getElementById(`hdrStatus${playerNumber}`);
        if (toggle) toggle.checked = this.enabled;
        if (input) {
          input.value = String(this.displayNits);
          input.disabled = !this.enabled;
          input.setAttribute('aria-valuetext', `${this.displayNits} nits`);
          const progress = ((this.displayNits - MIN_NITS) / (MAX_NITS - MIN_NITS)) * 100;
          input.style.setProperty('--hdr-nits-progress', `${progress}%`);
        }
        if (output) output.textContent = `${this.displayNits} nits`;
        if (!status) continue;
        const renderer = this.renderers.find((candidate) => candidate.playerNumber === playerNumber);
        if (!this.enabled) status.textContent = 'Off';
        else if (renderer?.error) status.textContent = `Unavailable: ${renderer.error.message}`;
        else if (!renderer?.videoColor) status.textContent = 'Waiting for video metadata';
        else if (!renderer.isHdr) status.textContent = 'SDR source · native video';
        else if (!renderer.toneMapSupported) status.textContent = 'Non-PQ HDR · native video';
        else if (!renderer.initialized) status.textContent = 'Starting GPU…';
        else status.textContent = 'HDR tone mapping · GPU frame copy';
      }
    }

    getMetrics() {
      return this.renderers.map((renderer) => renderer.snapshotMetrics());
    }
  }

  const manager = new HdrToneMappingManager();
  window.hdrToneMapping = manager;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => manager.initialize(), { once: true });
  } else {
    manager.initialize();
  }
})();
