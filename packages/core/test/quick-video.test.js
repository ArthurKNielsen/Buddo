import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agent.js';
import { planQuickVideo, wantsVideoEdit, attachedMedia, parseSteps } from '../src/index.js';
import { createNodeWorkspace } from '../src/node-workspace.js';

// The 1B model refuses video edits ("I can't create a TikTok…"), so it must not be asked at all.
const noModel = { async *stream() { throw new Error('the model was asked'); } };

test('the reported request becomes a clean TikTok edit', () => {
  const p = planQuickVideo('make a TikTok with a hook title, some text on the best part, and sound effects', { videos: ['clip.mov'], duration: 20, loudest: 11.3 });
  const ops = parseSteps(p.steps);
  assert.deepEqual(ops.map((o) => o.type), ['fit', 'text', 'zoom', 'sfx', 'text', 'fade']);
  assert.deepEqual(ops[0].size, [1080, 1920]);
  assert.equal(ops[1].anim, 'pop');
  assert.equal(ops[1].sound, 'pop');
  assert.deepEqual(ops[2].range, [11.15, 12.3], 'punch zoom on the loudest moment');
  assert.equal(ops[3].name, 'boom');
  assert.equal(ops[4].sound, 'whoosh');
  assert.equal(p.out, 'videos/clip-tiktok.mp4');
});

test('uses the user’s own words, length, music and clips', () => {
  const p = planQuickVideo('make it a short, first 30 seconds, title "POV: me rn" and "no way" on the best part, add music', { videos: ['a.mp4', 'b.mp4'], audios: ['beat.mp3'], duration: 60 });
  assert.match(p.steps, /^transition slide 0\.4 whoosh$/m);
  assert.match(p.steps, /^trim 0-30$/m);
  assert.match(p.steps, /^title "POV: me rn" 0-2\.2 sound pop$/m);
  assert.match(p.steps, /^text "no way" top /m);
  assert.match(p.steps, /^music beat\.mp3 volume 0\.25$/m);
  const plain = planQuickVideo('just trim it to the first 10 seconds', { videos: ['a.mp4'], duration: 40 });
  assert.equal(plain.steps, 'trim 0-10', 'plain means plain');
  const noSong = planQuickVideo('add music', { videos: ['a.mp4'], duration: 10 });
  assert.match(noSong.notes.join(), /attach a song/);
});

test('tells edits apart from questions', () => {
  assert.equal(wantsVideoEdit('make a TikTok with a hook title'), true);
  assert.equal(wantsVideoEdit('what happens in this video?', { attachedNow: true }), false);
  assert.equal(wantsVideoEdit('', { attachedNow: true }), true);
  assert.equal(wantsVideoEdit('add a green button'), false);
  assert.deepEqual(attachedMedia([{ role: 'user', content: 'x\n\n[Attached video: saved to the project as copy_ABC.mov — watch it]\n\n[Attached audio: saved to the project as beat.mp3]' }]), { videos: ['copy_ABC.mov'], audios: ['beat.mp3'] });
});

test('a tiny model gets the video edited without being asked', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-qv-'));
  const ws = createNodeWorkspace(dir);
  const calls = [];
  ws.media = {
    watch_video: async (a) => (calls.push(['watch', a]), { text: `VIDEO ${a.path} — 0:20.0 long, 1080×1920 (vertical), 30 fps, has audio.\nLoudness: loudest at 0:11.3`, images: [] }),
    edit_video: async (a) => (calls.push(['edit', a]), { text: `Saved ${a.out}`, images: [], display: { type: 'media', kind: 'made', saved: a.out } }),
  };
  const messages = [{ role: 'user', content: 'make a TikTok with a hook title, some text on the best part, and sound effects\n\n[Attached video: saved to the project as copy_56261ABA.mov — watch it with watch_video, edit it with edit_video]' }];
  const events = [];
  const res = await runAgent({ provider: noModel, model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', workspace: ws, messages, mode: 'auto', lite: true, onEvent: (e) => events.push(e) });
  assert.equal(res.status, 'done');
  assert.deepEqual(calls.map((c) => c[0]), ['watch', 'edit']);
  assert.equal(calls[1][1].inputs, 'copy_56261ABA.mov');
  assert.match(calls[1][1].steps, /title "Wait for it…" 0-2\.2 sound pop/);
  assert.match(calls[1][1].steps, /sound boom 11\.3/);
  assert.equal(calls[1][1].out, 'videos/copy_56261ABA-tiktok.mp4');
  const said = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.match(said, /Saved \*\*videos\/copy_56261ABA-tiktok\.mp4\*\*/);
  assert.match(said, /punch zoom \+ boom/);
  await fs.rm(dir, { recursive: true, force: true });
});
