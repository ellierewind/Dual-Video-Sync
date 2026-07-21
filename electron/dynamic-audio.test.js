const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAudioConversionArgs,
  makeCacheKey,
  parseProgressTime
} = require('./dynamic-audio');

test('whole-track conversion creates a finite browser-compatible PCM WAV', () => {
  const args = buildAudioConversionArgs('movie.mkv', 3, 'track.partial.wav');
  const joined = args.join(' ');
  assert.match(joined, /-i movie\.mkv/);
  assert.match(joined, /-map 0:3/);
  assert.match(joined, /-vn -sn -dn/);
  assert.match(joined, /-ac 2/);
  assert.match(joined, /-ar 48000/);
  assert.match(joined, /-c:a pcm_s16le/);
  assert.match(joined, /-rf64 auto/);
  assert.match(joined, /-f wav track\.partial\.wav/);
  assert.doesNotMatch(joined, /-ss|pipe:1|libopus|-c:v/);
});

test('conversion progress parses FFmpeg microsecond timestamps', () => {
  assert.equal(parseProgressTime('out_time_us=1250000'), 1.25);
  assert.equal(parseProgressTime('out_time_ms=2500000'), 2.5);
  assert.equal(parseProgressTime('progress=continue'), null);
});

test('audio cache keys change with source identity and selected track', () => {
  const stat = { size: 1234, mtimeMs: 5678 };
  const first = makeCacheKey('movie.mkv', stat, 1);
  assert.equal(first, makeCacheKey('movie.mkv', stat, 1));
  assert.notEqual(first, makeCacheKey('movie.mkv', stat, 2));
  assert.notEqual(first, makeCacheKey('movie.mkv', { ...stat, mtimeMs: 9999 }, 1));
});
