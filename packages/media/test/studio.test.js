import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSteps, parseVideoSize, captionChunks, makeVideo, editVideo, browserAvailable } from '../src/index.js';
import { ffmpeg, probe } from '../src/ffmpeg.js';

test('parses edit steps', () => {
  const s = parseSteps(`trim 0:05-0:20
- cut 1:02.5 to 1:04
speed 2x
crop vertical
fit square
text "Wait for it…" top 0:00-0:03 size 80 color yellow box
title 'Big news'
captions
fade out 1
music beat.mp3 volume 0.2
mute
logo brand/logo.png bottom-right size 10%
overlay lower-third.html 0:02-0:07
color bw
# a comment
stills 4`);
  assert.deepEqual(s[0], { type: 'trim', range: [5, 20] });
  assert.deepEqual(s[1], { type: 'cut', range: [62.5, 64] });
  assert.equal(s[2].x, 2);
  assert.deepEqual(s[3].size, [1080, 1920]);
  assert.deepEqual(s[4], { type: 'fit', size: [1080, 1080], name: 'square' });
  assert.deepEqual(s[5], { type: 'text', text: 'Wait for it…', at: 'top', range: [0, 3], size: 80, color: 'yellow', box: true, anim: 'slide', sound: undefined });
  assert.equal(s[6].text, 'Big news');
  assert.equal(s[6].at, 'center');
  assert.equal(s[7].type, 'captions');
  assert.deepEqual(s[8], { type: 'fade', dir: 'out', d: 1 });
  assert.deepEqual(s[9], { type: 'music', file: 'beat.mp3', volume: 0.2, replace: false });
  assert.deepEqual(s[10], { type: 'volume', x: 0 });
  assert.equal(s[11].file, 'brand/logo.png');
  assert.equal(s[11].pos, 'bottom-right');
  assert.equal(s[11].scale, 0.1);
  assert.deepEqual(s[12].range, [2, 7]);
  assert.equal(s[13].look, 'bw');
  assert.equal(s[14].seconds, 4);
  assert.equal(s.length, 15);
  assert.throws(() => parseSteps('spin 2'), /Unknown step "spin 2"/);
  assert.throws(() => parseSteps('trim the start'), /trim START-END/);
  assert.throws(() => parseSteps('color neon'), /looks are/);
});

test('video sizes and caption chunks', () => {
  assert.deepEqual(parseVideoSize('vertical'), [1080, 1920]);
  assert.deepEqual(parseVideoSize('720p'), [1280, 720]);
  assert.deepEqual(parseVideoSize('801x601'), [800, 600]);
  const c = captionChunks([{ start: 1, end: 3, text: 'one two three four five six seven eight' }], 4);
  assert.deepEqual(c, [
    { start: 1, end: 2, text: 'one two three four' },
    { start: 2, end: 3, text: 'five six seven eight' },
  ]);
});

let haveFfmpeg = true;
try {
  await ffmpeg(['-version']);
} catch {
  haveFfmpeg = false;
}

test('makes a video from UI elements and edits it', { skip: !haveFfmpeg ? 'ffmpeg not found' : !browserAvailable() ? 'no Chrome/Chromium installed' : false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-studio-'));
  // A CSS animation, a JS timer and a canvas drawn per frame — all on the virtual clock.
  await fs.writeFile(path.join(root, 'scene.html'), `<!doctype html><style>
    html,body{margin:0;width:100vw;height:100vh;overflow:hidden;background:#000}
    #box{position:absolute;left:0;top:0;width:100px;height:100px;background:#f00;animation:go 1s linear forwards}
    @keyframes go{to{transform:translateX(220px)}}
    canvas{position:absolute;right:0;bottom:0}
  </style><div id="box"></div><canvas width="100" height="100"></canvas><b id="n" style="color:#fff">0</b>
  <script>
    setTimeout(() => (n.textContent = 'late'), 1500);
    const ctx = document.querySelector('canvas').getContext('2d');
    window.videoDuration = 2;
    window.renderFrame = (t) => { ctx.fillStyle = t < 1 ? '#00f' : '#0f0'; ctx.fillRect(0, 0, 100, 100); };
  </script>`);
  await fs.writeFile(path.join(root, 'badge.html'), `<!doctype html><style>html,body{margin:0;background:transparent}div{position:absolute;left:10px;top:10px;width:60px;height:60px;background:#ff0}</style><div></div>`);
  const m = await makeVideo({ target: 'scene.html', size: '320x240', fps: 10, out: 'out/scene.mp4', root });
  assert.match(m.text, /Rendered 20 frames of scene\.html at 320×240, 10 fps/);
  assert.equal(m.display.saved, 'out/scene.mp4');
  const meta = await probe(path.join(root, 'out/scene.mp4'));
  assert.equal(meta.width, 320);
  assert.ok(Math.abs(meta.duration - 2) < 0.15, `duration ${meta.duration}`);
  // Pixel checks: the box is exactly halfway at 0.5s, the canvas switched colour at 1s.
  const px = async (t, x, y) => {
    const { stdout } = await ffmpeg(['-v', 'error', '-ss', String(t), '-i', path.join(root, 'out/scene.mp4'), '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    return [...stdout];
  };
  const red = ([r, g, b]) => r > 180 && g < 80 && b < 80;
  assert.ok(red(await px(0.5, 150, 50)) && !red(await px(0.5, 215, 50)), 'box moved 110px at 0.5s');
  assert.ok((await px(0.55, 270, 190))[2] > 180, 'canvas blue before 1s');
  assert.ok((await px(1.55, 270, 190))[1] > 180, 'canvas green after 1s');

  const e = await editVideo({ inputs: 'out/scene.mp4\nout/scene.mp4', steps: 'trim 0:01-0:03\ncrop square\ntext "hi" top\noverlay badge.html 0-1\nfade in 0.2', out: 'out/edit.mp4', root });
  assert.match(e.text, /Saved out\/edit\.mp4 — 0:02\.0 long, 1080×1080/);
  const em = await probe(path.join(root, 'out/edit.mp4'));
  assert.ok(em.audio, 'joined clips keep an audio track');
  await assert.rejects(editVideo({ inputs: 'out/edit.mp4', steps: 'mute', out: 'out/edit.mp4', root }), /overwrite an input/);
  await fs.rm(root, { recursive: true, force: true });
});
