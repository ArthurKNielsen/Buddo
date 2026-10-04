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

test('parses animations, sound effects and transitions', async () => {
  const { parseSteps } = await import('../src/index.js');
  const s = parseSteps(`title "Hi" 0-2 sound pop
text "yo" top type 1-3
text "plain" none
sound whoosh 0:02.5 volume 0.5
zoom 1.3 0:02-0:04
zoom slow
shake 1-2
flash 0:03
progress top color #ff0
transition slide 0.6 whoosh`);
  assert.deepEqual([s[0].anim, s[0].sound, s[1].anim, s[2].anim], ['pop', 'pop', 'type', 'none']);
  assert.deepEqual(s[3], { type: 'sfx', name: 'whoosh', at: 2.5, volume: 0.5 });
  assert.deepEqual(s[4], { type: 'zoom', range: [2, 4], amount: 1.3 });
  assert.equal(s[5].slow, true);
  assert.deepEqual(s[6], { type: 'shake', range: [1, 2], strength: 1 });
  assert.deepEqual(s[7], { type: 'flash', at: 3 });
  assert.deepEqual(s[8], { type: 'progress', at: 'top', color: '#ff0' });
  assert.deepEqual(s[9], { type: 'transition', name: 'slide', d: 0.6, sound: 'whoosh' });
  assert.throws(() => parseSteps('sound fart 2'), /sounds are pop/);
  assert.throws(() => parseSteps('transition spin'), /transitions are fade/);
});

test('animates text, mixes sound effects and crossfades clips', async () => {
  const io = fakeIo();
  await runEdit({ inputs: 'a.mp4\nb.mp4', steps: 'transition slide 0.5 whoosh\ntitle "Hi" 0-2 sound pop\ntext "typed" type 2-4\nzoom 1.3 3-4' }, io);
  const join = io.runs[0].join(' ');
  assert.match(join, /xfade=transition=slideleft:duration=0\.500:offset=5\.500/);
  assert.match(join, /acrossfade=d=0\.500/);
  const g = io.texts['/tmp/graph.txt'];
  assert.match(g, /anoisesrc/, 'whoosh on the transition');
  assert.match(g, /aevalsrc/, 'pop under the title');
  assert.match(g, /fontsize='\d+\*if\(lt\(t,0\.35\)/, 'title pops in');
  assert.match(g, /zoompan=z=/);
  assert.equal(Object.keys(io.texts).filter((k) => /text\d+\.txt/.test(k)).length, 1 + 5, 'typewriter draws the text in steps');
});
