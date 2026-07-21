const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ffmpegStaticPath = require('ffmpeg-static');
const ffprobeStaticPath = require('@derhuerst/ffprobe-static');

const SUBTITLE_CACHE_VERSION = 1;
const VOBSUB_CODEC_NAMES = new Set(['dvd_subtitle', 'vobsub']);
const DYNAMIC_AUDIO_CODEC_NAMES = new Set(['ac3', 'eac3', 'dts', 'dca', 'truehd', 'mlp']);

function unpackedBinaryPath(binaryPath) {
  return String(binaryPath || '').replace('app.asar', 'app.asar.unpacked');
}

function runProcess(binaryPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const details = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
      reject(new Error(details || `Subtitle process exited with code ${code}`));
    });
  });
}

function parseFrameRate(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split('/');
  const fps = parts.length === 2
    ? Number(parts[0]) / Number(parts[1])
    : Number(value);
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

function describeVobSubTrack(stream) {
  if (!stream || stream.codec_type !== 'subtitle' || !VOBSUB_CODEC_NAMES.has(stream.codec_name)) return null;
  return {
    streamIndex: Number(stream.index),
    codec: stream.codec_name,
    language: stream.tags?.language || 'und',
    title: stream.tags?.title || '',
    forced: Number(stream.disposition?.forced) === 1,
    default: Number(stream.disposition?.default) === 1
  };
}

function listVobSubTracks(streams) {
  return (Array.isArray(streams) ? streams : [])
    .map(describeVobSubTrack)
    .filter(Boolean);
}

function isEnglishTrack(track) {
  const language = String(track?.language || '').trim().toLowerCase();
  const title = String(track?.title || '').trim().toLowerCase();
  return language === 'eng'
    || language === 'en'
    || language.startsWith('en-')
    || /(^|\W)english(\W|$)/.test(title);
}

function chooseVobSubTrack(tracks) {
  const candidates = Array.isArray(tracks) ? tracks : [];
  const englishTracks = candidates.filter(isEnglishTrack);
  return englishTracks.find((track) => track.forced)
    || englishTracks.find((track) => track.default)
    || englishTracks[0]
    || candidates.find((track) => track.forced)
    || candidates.find((track) => track.default)
    || candidates[0]
    || null;
}

function describeAudioTrack(stream) {
  if (!stream || stream.codec_type !== 'audio' || !Number.isInteger(Number(stream.index))) return null;
  return {
    streamIndex: Number(stream.index),
    codec: stream.codec_name || 'unknown',
    profile: stream.profile || '',
    language: stream.tags?.language || 'und',
    title: stream.tags?.title || '',
    channels: Number.isFinite(Number(stream.channels)) ? Number(stream.channels) : null,
    channelLayout: stream.channel_layout || '',
    sampleRate: Number.isFinite(Number(stream.sample_rate)) ? Number(stream.sample_rate) : null,
    duration: Number.isFinite(Number(stream.duration)) ? Number(stream.duration) : null,
    default: Number(stream.disposition?.default) === 1,
    forced: Number(stream.disposition?.forced) === 1
  };
}

function listAudioTracks(streams) {
  return (Array.isArray(streams) ? streams : [])
    .map(describeAudioTrack)
    .filter(Boolean);
}

function chooseAudioTrack(tracks) {
  const candidates = Array.isArray(tracks) ? tracks : [];
  const englishTracks = candidates.filter(isEnglishTrack);
  return englishTracks.find((track) => track.default)
    || englishTracks[0]
    || candidates.find((track) => track.default)
    || candidates[0]
    || null;
}

function needsDynamicAudio(track) {
  return !!track && DYNAMIC_AUDIO_CODEC_NAMES.has(String(track.codec || '').trim().toLowerCase());
}

function buildSubtitleExtractionArgs(inputPath, outputPath, streamIndex) {
  return [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    '-map', `0:${streamIndex}`,
    '-c:s', 'copy',
    '-map_metadata', '-1',
    '-f', 'matroska',
    outputPath
  ];
}

class BitmapSubtitleService {
  constructor(app) {
    this.app = app;
    this.ffmpegPath = unpackedBinaryPath(ffmpegStaticPath);
    this.ffprobePath = unpackedBinaryPath(ffprobeStaticPath);
    this.inFlight = new Map();
  }

  async probe(filePath) {
    const { stdout } = await runProcess(this.ffprobePath, [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      filePath
    ]);
    return JSON.parse(stdout);
  }

  async inspectVideo(filePath) {
    const probe = await this.probe(filePath);
    const video = probe.streams?.find((stream) => stream.codec_type === 'video' && Number(stream?.disposition?.attached_pic) !== 1);
    const frameRate = parseFrameRate(video?.avg_frame_rate) || parseFrameRate(video?.r_frame_rate);
    const vobSubTracks = listVobSubTracks(probe.streams);
    const formatDuration = Number(probe.format?.duration);
    const audioTracks = listAudioTracks(probe.streams).map((track) => ({
      ...track,
      duration: Number.isFinite(track.duration) && track.duration > 0
        ? track.duration
        : (Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : null)
    }));
    const preferredAudioTrack = chooseAudioTrack(audioTracks);
    return {
      ...(frameRate ? { frameRate } : {}),
      vobSubTracks,
      selectedVobSubTrack: chooseVobSubTrack(vobSubTracks),
      audioTracks,
      selectedAudioTrack: needsDynamicAudio(preferredAudioTrack) ? preferredAudioTrack : null
    };
  }

  async getVideoMetadata(filePath) {
    return this.inspectVideo(filePath);
  }

  async loadTrack(filePath, streamIndex) {
    const inspected = await this.inspectVideo(filePath);
    const track = inspected.vobSubTracks.find((candidate) => candidate.streamIndex === Number(streamIndex));
    if (!track) throw new Error('The requested VobSub track was not found.');

    const sourceStat = await fs.promises.stat(filePath);
    const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
      version: SUBTITLE_CACHE_VERSION,
      filePath: path.resolve(filePath),
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      streamIndex: track.streamIndex
    })).digest('hex').slice(0, 24);
    const cacheDir = path.join(this.app.getPath('userData'), 'subtitle-cache');
    const outputPath = path.join(cacheDir, `${cacheKey}.mks`);
    const partialPath = path.join(cacheDir, `${cacheKey}.partial.mks`);

    await fs.promises.mkdir(cacheDir, { recursive: true });
    if (!fs.existsSync(outputPath)) {
      if (!this.inFlight.has(cacheKey)) {
        const work = this.extractTrack(filePath, track.streamIndex, partialPath, outputPath)
          .finally(() => this.inFlight.delete(cacheKey));
        this.inFlight.set(cacheKey, work);
      }
      await this.inFlight.get(cacheKey);
    }

    const content = await fs.promises.readFile(outputPath);
    const arrayBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    return { track, fileName: `${cacheKey}.mks`, content: arrayBuffer };
  }

  async extractTrack(inputPath, streamIndex, partialPath, outputPath) {
    await fs.promises.rm(partialPath, { force: true });
    try {
      await runProcess(this.ffmpegPath, buildSubtitleExtractionArgs(inputPath, partialPath, streamIndex));
      await fs.promises.rename(partialPath, outputPath);
    } catch (error) {
      await fs.promises.rm(partialPath, { force: true });
      throw error;
    }
  }
}

module.exports = {
  BitmapSubtitleService,
  buildSubtitleExtractionArgs,
  chooseAudioTrack,
  chooseVobSubTrack,
  listAudioTracks,
  listVobSubTracks,
  needsDynamicAudio,
  parseFrameRate
};
