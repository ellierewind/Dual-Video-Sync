const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ffmpegStaticPath = require('ffmpeg-static');
const ffprobeStaticPath = require('@derhuerst/ffprobe-static');

const SUBTITLE_CACHE_VERSION = 3;
const VOBSUB_CODEC_NAMES = new Set(['dvd_subtitle', 'vobsub']);
const PGS_CODEC_NAMES = new Set(['hdmv_pgs_subtitle', 'pgs']);
const ASS_CODEC_NAMES = new Set(['ass', 'ssa']);
const FONT_ATTACHMENT_CODECS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const FONT_ATTACHMENT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2']);
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

function describeAssTrack(stream) {
  if (!stream || stream.codec_type !== 'subtitle' || !ASS_CODEC_NAMES.has(stream.codec_name)) return null;
  return {
    streamIndex: Number(stream.index),
    codec: stream.codec_name,
    renderer: 'ass',
    language: stream.tags?.language || 'und',
    title: stream.tags?.title || '',
    forced: Number(stream.disposition?.forced) === 1,
    default: Number(stream.disposition?.default) === 1
  };
}

function describePgsTrack(stream) {
  if (!stream || stream.codec_type !== 'subtitle' || !PGS_CODEC_NAMES.has(stream.codec_name)) return null;
  return {
    streamIndex: Number(stream.index),
    codec: stream.codec_name,
    renderer: 'bitmap',
    bitmapFormat: 'pgs',
    language: stream.tags?.language || 'und',
    title: stream.tags?.title || '',
    forced: Number(stream.disposition?.forced) === 1,
    default: Number(stream.disposition?.default) === 1
  };
}

function describeEmbeddedSubtitleTrack(stream) {
  const vobSub = describeVobSubTrack(stream);
  return vobSub ? { ...vobSub, renderer: 'bitmap', bitmapFormat: 'vobsub' }
    : (describePgsTrack(stream) || describeAssTrack(stream));
}

function listVobSubTracks(streams) {
  return (Array.isArray(streams) ? streams : [])
    .map(describeVobSubTrack)
    .filter(Boolean);
}

function listEmbeddedSubtitleTracks(streams) {
  return (Array.isArray(streams) ? streams : [])
    .map(describeEmbeddedSubtitleTrack)
    .filter(Boolean);
}

function describeFontAttachment(stream, attachmentIndex) {
  if (!stream || stream.codec_type !== 'attachment') return null;
  const fileName = String(stream.tags?.filename || `font-${attachmentIndex}`);
  const extension = path.extname(fileName).toLowerCase();
  const mimeType = String(stream.tags?.mimetype || '').toLowerCase();
  const codec = String(stream.codec_name || '').toLowerCase();
  const isFont = FONT_ATTACHMENT_CODECS.has(codec)
    || FONT_ATTACHMENT_EXTENSIONS.has(extension)
    || mimeType.startsWith('font/')
    || /(?:truetype|opentype|woff)/.test(mimeType);
  if (!isFont) return null;
  return {
    streamIndex: Number(stream.index),
    attachmentIndex,
    fileName,
    extension: FONT_ATTACHMENT_EXTENSIONS.has(extension) ? extension : '.font'
  };
}

function listFontAttachments(streams) {
  let attachmentIndex = 0;
  const fonts = [];
  for (const stream of Array.isArray(streams) ? streams : []) {
    if (stream?.codec_type !== 'attachment') continue;
    const font = describeFontAttachment(stream, attachmentIndex);
    if (font) fonts.push(font);
    attachmentIndex += 1;
  }
  return fonts;
}

function isEnglishTrack(track) {
  const language = String(track?.language || '').trim().toLowerCase();
  const title = String(track?.title || '').trim().toLowerCase();
  return language === 'eng'
    || language === 'en'
    || language.startsWith('en-')
    || /(^|\W)english(\W|$)/.test(title);
}

function chooseEmbeddedSubtitleTrack(tracks) {
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

const chooseVobSubTrack = chooseEmbeddedSubtitleTrack;

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

function describeVideoColor(stream) {
  if (!stream || stream.codec_type !== 'video') return null;
  const transfer = String(stream.color_transfer || '').trim().toLowerCase();
  const primaries = String(stream.color_primaries || '').trim().toLowerCase();
  const matrix = String(stream.color_space || '').trim().toLowerCase();
  const pixelFormat = String(stream.pix_fmt || '').trim().toLowerCase();
  const bitsPerRawSample = Number(stream.bits_per_raw_sample);
  const pixelFormatDepth = Number(pixelFormat.match(/(?:p|yuv\d{3}p)(\d{2})(?:le|be)?$/)?.[1]);
  const bitDepth = Number.isFinite(bitsPerRawSample) && bitsPerRawSample > 0
    ? bitsPerRawSample
    : (Number.isFinite(pixelFormatDepth) ? pixelFormatDepth : (pixelFormat.includes('10') ? 10 : 8));
  const isPq = transfer === 'smpte2084';
  const isHlg = transfer === 'arib-std-b67';
  const isWideGamutHighBitDepth = bitDepth > 8 && (primaries === 'bt2020' || matrix.startsWith('bt2020'));

  return {
    transfer,
    primaries,
    matrix,
    pixelFormat,
    bitDepth,
    isHdr: isPq || isHlg || isWideGamutHighBitDepth
  };
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

function buildAssExtractionArgs(inputPath, outputPath, streamIndex) {
  return [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    '-map', `0:${streamIndex}`,
    '-c:s', 'copy',
    '-map_metadata', '-1',
    '-f', 'ass',
    outputPath
  ];
}

function buildPgsExtractionArgs(inputPath, outputPath, streamIndex) {
  return [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    '-map', `0:${streamIndex}`,
    '-c:s', 'copy',
    '-map_metadata', '-1',
    '-f', 'sup',
    outputPath
  ];
}

function buildAttachmentExtractionArgs(inputPath, outputPath, attachmentIndex) {
  return [
    '-hide_banner',
    '-y',
    `-dump_attachment:t:${attachmentIndex}`, outputPath,
    '-i', inputPath,
    '-map', '0:v:0?',
    '-frames:v', '0',
    '-f', 'null',
    '-'
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
    const vobSubTracks = listEmbeddedSubtitleTracks(probe.streams);
    const fontAttachments = listFontAttachments(probe.streams);
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
      videoColor: describeVideoColor(video),
      vobSubTracks,
      selectedVobSubTrack: chooseEmbeddedSubtitleTrack(vobSubTracks),
      fontAttachments,
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
    if (!track) throw new Error('The requested embedded subtitle track was not found.');

    const sourceStat = await fs.promises.stat(filePath);
    const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
      version: SUBTITLE_CACHE_VERSION,
      filePath: path.resolve(filePath),
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      streamIndex: track.streamIndex
    })).digest('hex').slice(0, 24);
    const cacheDir = path.join(this.app.getPath('userData'), 'subtitle-cache');
    const isAss = track.renderer === 'ass';
    const isPgs = track.bitmapFormat === 'pgs';
    const extension = isAss ? '.ass' : (isPgs ? '.sup' : '.mks');
    const outputPath = path.join(cacheDir, `${cacheKey}${extension}`);
    const partialPath = path.join(cacheDir, `${cacheKey}.partial${extension}`);

    await fs.promises.mkdir(cacheDir, { recursive: true });
    if (!fs.existsSync(outputPath)) {
      if (!this.inFlight.has(cacheKey)) {
        const work = this.extractTrack(filePath, track, partialPath, outputPath)
          .finally(() => this.inFlight.delete(cacheKey));
        this.inFlight.set(cacheKey, work);
      }
      await this.inFlight.get(cacheKey);
    }

    if (isAss) {
      const [content, fonts] = await Promise.all([
        fs.promises.readFile(outputPath, 'utf8'),
        this.loadFontAttachments(filePath, sourceStat, inspected.fontAttachments)
      ]);
      return { track, fileName: `${cacheKey}.ass`, content, fonts };
    }

    const content = await fs.promises.readFile(outputPath);
    const arrayBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    return { track, fileName: `${cacheKey}${extension}`, content: arrayBuffer, fonts: [] };
  }

  async extractTrack(inputPath, track, partialPath, outputPath) {
    await fs.promises.rm(partialPath, { force: true });
    try {
      const args = track.renderer === 'ass'
        ? buildAssExtractionArgs(inputPath, partialPath, track.streamIndex)
        : (track.bitmapFormat === 'pgs'
          ? buildPgsExtractionArgs(inputPath, partialPath, track.streamIndex)
          : buildSubtitleExtractionArgs(inputPath, partialPath, track.streamIndex));
      await runProcess(this.ffmpegPath, args);
      await fs.promises.rename(partialPath, outputPath);
    } catch (error) {
      await fs.promises.rm(partialPath, { force: true });
      throw error;
    }
  }

  async loadFontAttachments(inputPath, sourceStat, attachments) {
    const fonts = Array.isArray(attachments) ? attachments : [];
    if (fonts.length === 0) return [];
    const sourceKey = crypto.createHash('sha256').update(JSON.stringify({
      version: SUBTITLE_CACHE_VERSION,
      filePath: path.resolve(inputPath),
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs
    })).digest('hex').slice(0, 24);
    const fontDir = path.join(this.app.getPath('userData'), 'subtitle-cache', `${sourceKey}-fonts`);
    await fs.promises.mkdir(fontDir, { recursive: true });

    return Promise.all(fonts.map(async (attachment) => {
      const outputPath = path.join(fontDir, `${attachment.attachmentIndex}${attachment.extension}`);
      const partialPath = `${outputPath}.partial`;
      const inFlightKey = `${sourceKey}:font:${attachment.attachmentIndex}`;
      if (!fs.existsSync(outputPath)) {
        if (!this.inFlight.has(inFlightKey)) {
          const work = this.extractFontAttachment(inputPath, attachment.attachmentIndex, partialPath, outputPath)
            .finally(() => this.inFlight.delete(inFlightKey));
          this.inFlight.set(inFlightKey, work);
        }
        await this.inFlight.get(inFlightKey);
      }
      const content = await fs.promises.readFile(outputPath);
      return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    }));
  }

  async extractFontAttachment(inputPath, attachmentIndex, partialPath, outputPath) {
    await fs.promises.rm(partialPath, { force: true });
    try {
      await runProcess(this.ffmpegPath, buildAttachmentExtractionArgs(inputPath, partialPath, attachmentIndex));
      await fs.promises.rename(partialPath, outputPath);
    } catch (error) {
      await fs.promises.rm(partialPath, { force: true });
      throw error;
    }
  }
}

module.exports = {
  BitmapSubtitleService,
  buildAssExtractionArgs,
  buildAttachmentExtractionArgs,
  buildPgsExtractionArgs,
  buildSubtitleExtractionArgs,
  chooseAudioTrack,
  chooseEmbeddedSubtitleTrack,
  chooseVobSubTrack,
  describeVideoColor,
  listAudioTracks,
  listEmbeddedSubtitleTracks,
  listFontAttachments,
  listVobSubTracks,
  needsDynamicAudio,
  parseFrameRate
};
