import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, gatherContext } from '../src/index.js';
import { parseLearned } from '../src/personality.js';

// The website: a browser project that edits videos with ffmpeg.wasm (no speech, no browser to render HTML, .mp4/.gif).
const website = { name: 'my-project', kind: 'browser sandbox', capabilities: { exec: false, fetch: true }, media: { edit_video() {}, watch_video() {}, outputs: ['.mp4', '.gif'] }, webSearch() {} };
const INVENTED = /app\.js|hello\.py|router|\/health|function login|\*\*\/\*\.py|beat\.mp3|src\//;

for (const lite of [false, true]) {
  test(`${lite ? 'short' : 'full'} prompt never names a file the user doesn't have`, () => {
    const empty = buildSystemPrompt({ workspace: website, files: [], lite });
    assert.doesNotMatch(empty, INVENTED);
    assert.match(empty, /The project is EMPTY/);
    const mine = buildSystemPrompt({ workspace: website, files: ['home.html', 'css/site.css', 'party.mov'], lite });
    assert.doesNotMatch(mine, INVENTED);
    assert.match(mine, /only these exist/);
    assert.match(mine, /- css\/site\.css/);
    assert.match(mine, /<path>home\.html<\/path>/, 'examples use the real page');
    assert.match(mine, /<input>party\.mov<\/input>/, 'and the real video');
    assert.match(mine, /Never read or mention any other file|Never read, edit or mention any other file/);
  });
}

test('the website prompt only promises what the website can do', () => {
  const p = buildSystemPrompt({ workspace: website, files: [] });
  assert.doesNotMatch(p, /captions \(auto|lower-third\.html|\.webm, \.mov|speech transcript with timestamps|listen_audio|view_image|make_video/);
  assert.match(p, /\.mp4, \.gif \(default/);
  assert.match(p, /no speech transcript or object detection here/i);
  const desktop = { ...website, kind: 'local folder', capabilities: { exec: true }, media: { edit_video() {}, watch_video() {}, listen_audio() {}, view_image() {}, make_video() {}, screenshot() {} } };
  const d = buildSystemPrompt({ workspace: desktop, files: [] });
  assert.match(d, /captions \(auto subtitles from speech\)/);
  assert.match(d, /overlay lower-third\.html/);
  assert.match(d, /\.mp4, \.webm, \.mov, \.gif/);
});

test('the rules end with a short recap, and big projects are not called complete', () => {
  const p = buildSystemPrompt({ workspace: website, files: ['index.html'] });
  assert.match(p.trim().split('\n').slice(-5).join('\n'), /Saved means saved/);
  const many = Array.from({ length: 120 }, (_, i) => `page${i}.html`);
  const big = buildSystemPrompt({ workspace: website, files: many });
  assert.match(big, /The project has 120 files\. The first 80/);
  assert.doesNotMatch(big, /only these exist/);
});

test('the project context lists every file', async () => {
  const ws = { list: async (_p, depth) => (depth > 2 ? [{ path: 'a', type: 'dir' }, { path: 'a/b.css', type: 'file' }, { path: 'index.html', type: 'file' }] : [{ path: 'index.html', type: 'file' }, { path: 'a', type: 'dir' }]), read: async () => { throw new Error('none'); } };
  const ctx = await gatherContext(ws);
  assert.deepEqual(ctx.files, ['a/b.css', 'index.html']);
});

test('file names are never remembered about the user', () => {
  assert.deepEqual(parseLearned('- Has a project with src/app.js\n- Likes dark themes\n- Building index.html for a coffee shop\n- Is learning React'), ['Likes dark themes', 'Is learning React']);
});
