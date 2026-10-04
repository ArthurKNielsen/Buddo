import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEdit, parseProbe, parseVideoSize } from '../src/index.js';

const PROBE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Duration: 00:00:06.00, start: 0.000000, bitrate: 193 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 3840x2160 [SAR 1:1 DAR 16:9], 113 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)
At least one output file must be specified`;

/** A pretend ffmpeg: records every command and text file instead of running anything. */
function fakeIo(extra = {}) {
  const runs = [];
  const texts = {};
  return {
    runs,
    texts,
    input: async (f) => `/in/${f}`,
    probe: async () => parseProbe(PROBE),
    temp: (n) => `/tmp/${n}`,
    writeText: async (p, t) => (texts[p] = t),
    ffmpeg: async (args) => runs.push(args),
    finish: async (args, out) => runs.push([...args, out]),
    encode: () => ['-c:v', 'libx264'],
    font: '/fonts/x.ttf',
    output: async (t) => `/out/${t}`,
    ...extra,
  };
}

test('reads media info from ffmpeg output', () => {
  const m = parseProbe(PROBE, 123);
  assert.deepEqual([m.duration, m.width, m.height, m.fps, m.video, m.audio, m.size], [6, 3840, 2160, 30, true, true, 123]);
  assert.throws(() => parseProbe('nope: No such file or directory'), /Can't read media file: nope/);
  assert.deepEqual(parseVideoSize('vertical'), [1080, 1920]);
});

test('builds one ffmpeg graph for the steps, keeping the shape under maxSize', async () => {
  const io = fakeIo({ maxSize: 1920 });
  const r = await runEdit({ inputs: 'clip.mp4', steps: 'trim 1-5\ntext "hi gang" top\nlogo logo.png\nmusic beat.mp3', out: 'videos/out.mp4' }, io);
  assert.equal(r.out, 'videos/out.mp4');
  assert.equal(r.path, '/out/videos/out.mp4');
  const graph = io.texts['/tmp/graph.txt'];
  assert.match(graph, /scale=1920:1080:force_original_aspect_ratio/, '4K shrinks to 1080p, same shape');
  assert.match(graph, /trim=start=1:end=5/);
  assert.match(graph, /drawtext=fontfile='\/fonts\/x.ttf':textfile='\/tmp\/text0.txt'/);
  assert.match(graph, /eof_action=repeat/, 'a logo stays up');
  assert.match(graph, /amix=inputs=2/);
  assert.equal(io.texts['/tmp/text0.txt'], 'hi gang');
  assert.deepEqual(io.runs.length, 1);
  assert.ok(io.runs[0].includes('/in/beat.mp3') && io.runs[0].includes('/in/logo.png'));
  assert.equal(io.runs[0].at(-1), '/out/videos/out.mp4');
});

test('joins several inputs in a pass of their own', async () => {
  const io = fakeIo();
  await runEdit({ inputs: 'a.mp4\nb.jpg', steps: 'trim 0-2' }, io);
  assert.equal(io.runs.length, 2);
  assert.ok(io.runs[0].join(' ').includes('concat=n=2'));
  assert.equal(io.runs[0].at(-1), '/tmp/joined.mp4');
  assert.ok(io.runs[0].includes('-loop'), 'photos become still clips');
});

test('says clearly what needs the desktop app', async () => {
  await assert.rejects(runEdit({ inputs: 'clip.mp4', steps: 'captions' }, fakeIo()), /Auto captions need the Buddo desktop app/);
  await assert.rejects(runEdit({ inputs: 'clip.mp4', steps: 'overlay lower-third.html' }, fakeIo()), /HTML overlays \(lower-third.html\) need/);
  await assert.rejects(runEdit({ inputs: 'clip.mp4', out: './clip.mp4' }, fakeIo()), /overwrite an input/);
  await assert.rejects(runEdit({ inputs: 'clip.mp4', out: 'x.avi' }, fakeIo()), /\.mp4, \.webm, \.mov or \.gif/);
});
