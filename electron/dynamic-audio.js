const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ffmpegStaticPath = require('ffmpeg-static');

const AUDIO_CACHE_VERSION = 1;
const MAX_CACHE_BYTES = 6 * 1024 * 1024 * 1024;

function unpackedBinaryPath(binaryPath) {
  return String(binaryPath || '').replace('app.asar', 'app.asar.unpacked');
}

function buildAudioConversionArgs(filePath, streamIndex, outputPath) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-y',
    '-i', filePath,
    '-map', `0:${Number(streamIndex)}`,
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata', '-1',
    '-ac', '2',
    '-ar', '48000',
    '-c:a', 'pcm_s16le',
    '-progress', 'pipe:2',
    '-nostats',
    '-rf64', 'auto',
    '-f', 'wav',
    outputPath
  ];
}

function parseProgressTime(line) {
  const match = /^(?:out_time_us|out_time_ms)=(\d+)$/.exec(String(line || '').trim());
  if (!match) return null;
  return Number(match[1]) / 1_000_000;
}

function makeCacheKey(filePath, stat, streamIndex) {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: AUDIO_CACHE_VERSION,
    filePath: path.resolve(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    streamIndex: Number(streamIndex),
    format: 'wav-pcm-s16le-stereo-48000'
  })).digest('hex').slice(0, 24);
}

class DynamicAudioService {
  constructor(app) {
    this.app = app;
    this.ffmpegPath = unpackedBinaryPath(ffmpegStaticPath);
    this.inFlight = new Map();
    this.active = new Set();
  }

  get cacheDir() {
    return path.join(this.app.getPath('userData'), 'audio-cache');
  }

  async prepareTrack(filePath, track, onProgress) {
    const stat = await fs.promises.stat(filePath);
    const cacheKey = makeCacheKey(filePath, stat, track.streamIndex);
    const outputPath = path.join(this.cacheDir, `${cacheKey}.wav`);
    const partialPath = path.join(this.cacheDir, `${cacheKey}.partial.wav`);
    await fs.promises.mkdir(this.cacheDir, { recursive: true });

    if (await this.isUsableCacheFile(outputPath)) {
      await fs.promises.utimes(outputPath, new Date(), new Date()).catch(() => { });
      onProgress?.(1);
      return this.describePrepared(cacheKey, outputPath, true);
    }

    let job = this.inFlight.get(cacheKey);
    if (!job) {
      job = {
        listeners: new Set(),
        promise: this.convertTrack(filePath, track, partialPath, outputPath, cacheKey)
      };
      this.inFlight.set(cacheKey, job);
      job.promise.then(
        () => this.inFlight.delete(cacheKey),
        () => this.inFlight.delete(cacheKey)
      );
    }
    if (typeof onProgress === 'function') job.listeners.add(onProgress);
    try {
      const result = await job.promise;
      onProgress?.(1);
      return result;
    } finally {
      if (typeof onProgress === 'function') job.listeners.delete(onProgress);
    }
  }

  describePrepared(cacheKey, outputPath, cached) {
    return {
      cacheKey,
      url: pathToFileURL(outputPath).toString(),
      cached: !!cached
    };
  }

  async isUsableCacheFile(filePath) {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile() && stat.size > 44;
    } catch {
      return false;
    }
  }

  notifyProgress(cacheKey, progress) {
    const job = this.inFlight.get(cacheKey);
    if (!job) return;
    const normalized = Math.max(0, Math.min(1, Number(progress) || 0));
    for (const listener of job.listeners) {
      try { listener(normalized); } catch { }
    }
  }

  async convertTrack(filePath, track, partialPath, outputPath, cacheKey) {
    await fs.promises.rm(partialPath, { force: true });
    const duration = Number(track.duration);
    const child = spawn(this.ffmpegPath, buildAudioConversionArgs(
      filePath,
      track.streamIndex,
      partialPath
    ), {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    this.active.add(child);

    let stderr = '';
    let pending = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-32768);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      if (!Number.isFinite(duration) || duration <= 0) return;
      for (const line of lines) {
        const seconds = parseProgressTime(line);
        if (seconds !== null) this.notifyProgress(cacheKey, seconds / duration);
      }
    });

    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr.trim().split(/\r?\n/).slice(-8).join('\n') || `Audio conversion exited with code ${code}`));
        });
      });
      await fs.promises.rename(partialPath, outputPath);
      this.notifyProgress(cacheKey, 1);
      this.pruneCache(outputPath).catch(() => { });
      return this.describePrepared(cacheKey, outputPath, false);
    } catch (error) {
      await fs.promises.rm(partialPath, { force: true });
      throw error;
    } finally {
      this.active.delete(child);
    }
  }

  async pruneCache(currentPath) {
    const entries = await fs.promises.readdir(this.cacheDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.wav')) continue;
      const filePath = path.join(this.cacheDir, entry.name);
      const stat = await fs.promises.stat(filePath);
      files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.slice().reverse()) {
      if (total <= MAX_CACHE_BYTES) break;
      if (file.filePath === currentPath) continue;
      await fs.promises.rm(file.filePath, { force: true });
      total -= file.size;
    }
  }

  dispose() {
    for (const child of this.active) {
      try { child.kill(); } catch { }
    }
    this.active.clear();
  }
}

module.exports = {
  DynamicAudioService,
  buildAudioConversionArgs,
  makeCacheKey,
  parseProgressTime
};
