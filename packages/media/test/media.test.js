import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watchVideo, listenAudio, viewImage, modelStatus } from '../src/index.js';
import { ffmpeg } from '../src/ffmpeg.js';

const ready = modelStatus().every((m) => m.installed);
const opts = { skip: ready ? false : 'models not downloaded (run Settings → Senses, or ensureAll())' };

test('watches a video: scene cut, frames, sounds — fast', opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-media-'));
  const file = path.join(dir, 'two-scenes.mp4');
  // 3s test pattern → 3s solid red, with a 440 Hz tone the whole time.
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3', '-f', 'lavfi', '-i', 'color=red:size=640x360:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-map', '2:a', '-g', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file]);
  const t = Date.now();
  const r = await watchVideo(file);
  const ms = Date.now() - t;
  assert.equal(r.images.length, 1, 'one contact sheet for the model');
  assert.ok(r.display.frames.length >= 4);
  assert.ok(r.display.cuts.some((c) => Math.abs(c - 3) < 1.1), `cut near 3s, got ${r.display.cuts}`);
  assert.match(r.text, /Sine wave|Tone|Beep|Sound/i);
  assert.ok(ms < 20000, `took ${ms}ms`);
  const again = Date.now();
  await watchVideo(file);
  assert.ok(Date.now() - again < 50, 'second look is cached');
  const a = await listenAudio(file);
  assert.equal(a.display.kind, 'audio');
  const frame = path.join(dir, 'frame.png');
  await ffmpeg(['-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-y', frame]);
  const v = await viewImage(frame);
  assert.equal(v.images.length, 1);
  assert.match(v.text, /IMAGE frame\.png — 640×360/);
  await fs.rm(dir, { recursive: true, force: true });
});

import { browserAvailable, screenshot, recordVideo } from '../src/index.js';
const hasBrowser = browserAvailable();

test('screenshots its own page, runs actions and reports layout bugs', { skip: hasBrowser ? false : 'no Chrome/Chromium installed' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-shot-'));
  await fs.writeFile(path.join(root, 'index.html'), `<!doctype html><title>Counter</title><h1 id="n">0</h1><button onclick="n.textContent=+n.textContent+1">Add one</button><div style="width:900px;height:10px" class="wide"></div><img src="nope.png">`);
  const s = await screenshot({ target: '', size: 'mobile', root, actions: 'click Add one\nclick Add one' });
  assert.equal(s.images.length, 1);
  assert.match(s.text, /Screenshot of index\.html at 390×844/);
  assert.match(s.text, /clicked <button> "Add one"/);
  assert.match(s.text, /horizontal overflow/);
  assert.match(s.text, /div\.wide/);
  assert.match(s.text, /broken images: nope\.png/);
  assert.match(s.text, /Visible text: 2/);
  const r = await recordVideo({ target: 'index.html', root, actions: 'click Add one', seconds: 0.5 });
  assert.match(r.text, /Saved [\d.]+s video/);
  assert.ok(r.display.saved.startsWith('.buddo/recordings/'));
  assert.equal(r.images.length, 1);
  await fs.rm(root, { recursive: true, force: true });
});
