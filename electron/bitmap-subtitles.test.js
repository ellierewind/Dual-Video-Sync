const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildAssExtractionArgs,
  buildAttachmentExtractionArgs,
  buildSubtitleExtractionArgs,
  chooseAudioTrack,
  chooseVobSubTrack,
  listAudioTracks,
  listEmbeddedSubtitleTracks,
  listFontAttachments,
  listVobSubTracks,
  needsDynamicAudio,
  parseFrameRate
} = require('./bitmap-subtitles');

function stream(index, codecType, codecName, disposition = {}) {
  return { index, codec_type: codecType, codec_name: codecName, disposition };
}

test('parseFrameRate handles rational rates', () => {
  assert.equal(parseFrameRate('24000/1001'), 24000 / 1001);
  assert.equal(parseFrameRate('30/1'), 30);
  assert.equal(parseFrameRate('0/0'), null);
});

test('VobSub discovery ignores video, audio, and text subtitle streams', () => {
  const tracks = listVobSubTracks([
    stream(0, 'video', 'h264'),
    stream(1, 'audio', 'aac'),
    stream(2, 'subtitle', 'subrip'),
    { ...stream(3, 'subtitle', 'dvd_subtitle'), tags: { language: 'eng' } }
  ]);
  assert.deepEqual(tracks.map((track) => track.streamIndex), [3]);
  assert.equal(tracks[0].language, 'eng');
});

test('embedded subtitle discovery includes ASS, SSA, and VobSub without plain text tracks', () => {
  const tracks = listEmbeddedSubtitleTracks([
    stream(0, 'video', 'h264'),
    stream(1, 'subtitle', 'subrip'),
    { ...stream(2, 'subtitle', 'ass'), tags: { language: 'eng' } },
    { ...stream(3, 'subtitle', 'ssa'), tags: { language: 'jpn' } },
    stream(4, 'subtitle', 'dvd_subtitle')
  ]);
  assert.deepEqual(tracks.map((track) => [track.streamIndex, track.renderer]), [
    [2, 'ass'], [3, 'ass'], [4, 'bitmap']
  ]);
});

test('font attachment discovery accepts common embedded font formats only', () => {
  const attachments = listFontAttachments([
    { ...stream(3, 'attachment', 'ttf'), tags: { filename: 'Title.ttf', mimetype: 'application/x-truetype-font' } },
    { ...stream(4, 'attachment', 'bin'), tags: { filename: 'poster.jpg', mimetype: 'image/jpeg' } },
    { ...stream(5, 'attachment', 'otf'), tags: { filename: 'Signs.otf', mimetype: 'font/otf' } }
  ]);
  assert.deepEqual(attachments.map((font) => [font.streamIndex, font.attachmentIndex, font.extension]), [
    [3, 0, '.ttf'], [5, 2, '.otf']
  ]);
});

test('track selection always prefers English before non-English tracks', () => {
  const tracks = [
    { streamIndex: 2, language: 'jpn', forced: true, default: true },
    { streamIndex: 3, language: 'eng', forced: false, default: true },
    { streamIndex: 4, language: 'eng', forced: true, default: false }
  ];
  assert.equal(chooseVobSubTrack(tracks).streamIndex, 4);
  assert.equal(chooseVobSubTrack(tracks.slice(0, 2)).streamIndex, 3);
});

test('track selection falls back to forced, default, then first when English is absent', () => {
  const tracks = [
    { streamIndex: 2, language: 'jpn', forced: false, default: false },
    { streamIndex: 3, language: 'fra', forced: false, default: true },
    { streamIndex: 4, language: 'deu', forced: true, default: false }
  ];
  assert.equal(chooseVobSubTrack(tracks).streamIndex, 4);
});

test('English track titles are recognized when the language tag is missing', () => {
  const tracks = [
    { streamIndex: 2, language: 'und', title: 'Japanese', forced: true, default: true },
    { streamIndex: 3, language: 'und', title: 'English SDH', forced: false, default: false }
  ];
  assert.equal(chooseVobSubTrack(tracks).streamIndex, 3);
});

test('audio discovery includes AC-3 and DTS-HD metadata', () => {
  const tracks = listAudioTracks([
    stream(0, 'video', 'hevc'),
    { ...stream(1, 'audio', 'ac3', { default: 1 }), channels: 6, channel_layout: '5.1(side)', tags: { language: 'eng' } },
    { ...stream(2, 'audio', 'dts'), profile: 'DTS-HD MA', channels: 8, channel_layout: '7.1', tags: { language: 'jpn', title: 'Japanese lossless' } }
  ]);
  assert.deepEqual(tracks.map((track) => track.streamIndex), [1, 2]);
  assert.equal(tracks[0].codec, 'ac3');
  assert.equal(tracks[1].profile, 'DTS-HD MA');
  assert.equal(tracks[1].channels, 8);
});

test('audio selection prefers default English, then English, then file default', () => {
  const tracks = [
    { streamIndex: 1, language: 'jpn', default: true },
    { streamIndex: 2, language: 'eng', default: false },
    { streamIndex: 3, language: 'eng', default: true }
  ];
  assert.equal(chooseAudioTrack(tracks).streamIndex, 3);
  assert.equal(chooseAudioTrack(tracks.slice(0, 2)).streamIndex, 2);
  assert.equal(chooseAudioTrack(tracks.slice(0, 1)).streamIndex, 1);
});

test('only codecs missing from normal Chromium playback enable dynamic audio by default', () => {
  assert.equal(needsDynamicAudio({ codec: 'ac3' }), true);
  assert.equal(needsDynamicAudio({ codec: 'dts', profile: 'DTS-HD MA' }), true);
  assert.equal(needsDynamicAudio({ codec: 'aac' }), false);
  assert.equal(needsDynamicAudio({ codec: 'opus' }), false);
});

test('both players expose subtitle and audio selectors with loading indicators', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const playerNum of [1, 2]) {
    assert.match(html, new RegExp(`id="vobSubTrackSelect${playerNum}"`));
    assert.match(html, new RegExp(`id="vobSubTrackStatus${playerNum}"`));
    assert.match(html, new RegExp(`id="vobSubIndicator${playerNum}"`));
    assert.match(html, new RegExp(`id="audioTrackSelect${playerNum}"`));
    assert.match(html, new RegExp(`id="audioTrackStatus${playerNum}"`));
    assert.match(html, new RegExp(`id="audioIndicator${playerNum}"`));
    assert.match(html, new RegExp(`id="subtitle${playerNum}"[^>]+accept="[^"]*\\.ass,[^"]*\\.ssa`));
  }
  assert.match(html, /renderer\/ass-subtitles\.js/);
});

test('subtitle extraction copies only the selected subtitle stream', () => {
  const args = buildSubtitleExtractionArgs('movie.mkv', 'track.mks', 5);
  const joined = args.join(' ');
  assert.match(joined, /-map 0:5/);
  assert.match(joined, /-c:s copy/);
  assert.match(joined, /-f matroska/);
  assert.doesNotMatch(joined, /-c:v|-c:a|overlay|libx264/);
});

test('ASS extraction preserves the selected script without touching audio or video', () => {
  const args = buildAssExtractionArgs('movie.mkv', 'track.ass', 7);
  const joined = args.join(' ');
  assert.match(joined, /-map 0:7/);
  assert.match(joined, /-c:s copy/);
  assert.match(joined, /-f ass/);
  assert.doesNotMatch(joined, /-c:v|-c:a|overlay|libx264/);
});

test('font extraction uses FFmpeg attachment dumping for one selected attachment', () => {
  const args = buildAttachmentExtractionArgs('movie.mkv', 'font.ttf', 2);
  assert.match(args.join(' '), /-dump_attachment:t:2 font\.ttf/);
  assert.doesNotMatch(args.join(' '), /overlay|libx264/);
});
