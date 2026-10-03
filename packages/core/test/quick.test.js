import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent, slimHistory } from '../src/agent.js';
import { parseQuick, quickChange } from '../src/quick.js';
import { diffLines } from '../src/diff.js';
import { createNodeWorkspace } from '../src/node-workspace.js';

// A model that must not be asked: simple requests are Buddo's own job now.
const noModel = { async *stream() { throw new Error('the model was asked'); } };

async function say(dir, messages, prompt, { provider = noModel, lite = true } = {}) {
  messages.push({ role: 'user', content: prompt });
  const events = [];
  const res = await runAgent({ provider, model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', workspace: createNodeWorkspace(dir), messages, mode: 'auto', lite, onEvent: (e) => events.push(e) });
  return { res, events, page: await fs.readFile(path.join(dir, 'index.html'), 'utf8').catch(() => null) };
}
const changed = (a, b) => diffLines(a, b).filter((d) => d.type !== ' ');

test('the phone test, start to finish, without asking the model once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-quick-'));
  const messages = [];
  const made = await say(dir, messages, 'add a green button');
  assert.equal(made.res.status, 'done');
  assert.match(made.page, /<button style="background-color: green; color: white;[^"]*">Click me<\/button>/);
  assert.doesNotMatch(made.page, /<h1>|<p>|<script/, 'just the button, nothing extra');
  assert.match(made.events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /Made index\.html with a green button/);

  const blue = await say(dir, messages, 'Change the buttons coloe to blue');
  assert.equal(blue.res.status, 'done');
  const d = changed(made.page, blue.page);
  assert.equal(d.length, 2, 'one line out, one line in');
  assert.match(d[1].text, /background-color: blue/);

  await fs.writeFile(path.join(dir, 'index.html'), blue.page.replace('<body>\n', '<body>\n  <p>Press the button</p>\n'));
  const before = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  const gone = await say(dir, messages, 'Remove the text above the button');
  assert.deepEqual(changed(before, gone.page).map((x) => x.type), ['-'], 'only a deleted line');

  const start = await say(dir, messages, 'make the button say Start');
  assert.match(start.page, />Start<\/button>/);
  assert.equal(changed(gone.page, start.page).length, 2);
  // The chat remembers what Buddo did, for the model's next turn.
  assert.match(messages.at(-1).content, /^Done: The button now says "Start"\.[\s\S]*\[Buddo saved these code blocks as files: index\.html \(edited\)\]/);
});

test('anything that is not simple still goes to the model', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-quick-'));
  let asked = 0;
  const provider = { async *stream() { asked++; yield { type: 'text', text: 'Sure, what kind of game?' }; } };
  await say(dir, [], 'make a snake game', { provider });
  await say(dir, [], 'add a button that plays a sound', { provider });
  await say(dir, [], 'remove everything except the green button', { provider });
  assert.equal(asked, 3);
});

test('requests: what each one means', () => {
  const p = (t) => parseQuick(t);
  assert.deepEqual(p('add a green button'), { action: 'create', el: 'button', color: 'green', text: null });
  assert.deepEqual(p('make a red heading that says "Hi there"'), { action: 'create', el: 'heading', color: 'red', text: 'Hi there' });
  assert.equal(p('Change the buttons coloe to blue').color, 'blue', 'a typo of "color" still counts');
  assert.deepEqual(p('can you make the button light blue please'), { action: 'color', el: 'button', part: 'background', color: 'lightblue', all: false });
  assert.equal(p('change the heading to blue').part, 'text', 'a heading has a text color');
  assert.deepEqual(p('change the heading to Welcome'), { action: 'text', el: 'heading', text: 'Welcome' });
  assert.deepEqual(p('remove the text above the button'), { action: 'remove', el: 'button', near: 'above' });
  assert.equal(p('make the green button blue').color, 'blue');
  assert.equal(p('make the button a lot bigger').factor, 1.5);
  for (const t of ['make a snake game', 'make me a website with a button', 'add a big button', 'remove everything except the green button', 'make the button bigger and red', 'how do I make the button blue?']) assert.equal(p(t), null, t);
});

const PAGE = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial; }
    .green-button {
      background-color: green;
      color: white;
    }
    .green-button:hover { background-color: darkgreen; }
  </style>
</head>
<body>
  <h1>Welcome</h1>
  <p>Click below.</p>
  <button class="green-button">Green</button>
  <script>
    document.querySelector('button').onclick = () => alert('<button>');
  </script>
</body>
</html>
`;
const page = { path: 'index.html', content: PAGE };
const diff = (r) => changed(r.changes[0].before, r.changes[0].after).map((d) => `${d.type} ${d.text.trim()}`);

test('changes land on the one line that controls them', () => {
  assert.deepEqual(diff(quickChange('make the button blue', { page })), ['- background-color: green;', '+ background-color: blue;']);
  assert.deepEqual(diff(quickChange('make the text white', { page })), ['- body { font-family: Arial; }', '+ body { font-family: Arial; color: white; }']);
  assert.deepEqual(diff(quickChange('remove the heading', { page })), ['- <h1>Welcome</h1>']);
  assert.deepEqual(diff(quickChange('change the heading to Hello there', { page })), ['- <h1>Welcome</h1>', '+ <h1>Hello there</h1>']);
  assert.deepEqual(diff(quickChange('add a red button that says Stop', { page })), ['+ <button style="background-color: red; color: white; padding: 10px 20px; font-size: 16px; border: none; border-radius: 8px; cursor: pointer;">Stop</button>']);
  assert.match(quickChange('add a red button', { page }).changes[0].after, /Stop|Click me<\/button>\n  <script>/, 'added above the script, not inside it');
  assert.deepEqual(diff(quickChange('make the heading smaller', { page })), ['- <h1>Welcome</h1>', '+ <h1 style="font-size: 1.6em;">Welcome</h1>']);
  // In the linked stylesheet, when that's where the button is styled.
  const linked = { path: 'index.html', content: '<html>\n<head>\n<link rel="stylesheet" href="styles.css">\n</head>\n<body>\n<button class="btn">Go</button>\n</body>\n</html>\n' };
  const r = quickChange('make the button red', { page: linked, files: [{ path: 'styles.css', content: '.btn {\n  padding: 8px;\n  background: #333;\n}\n' }] });
  assert.equal(r.changes[0].path, 'styles.css');
  assert.equal(r.changes[0].after, '.btn {\n  padding: 8px;\n  background: red;\n}\n');
  assert.match(r.summary, /in styles\.css/);
});

test('when it is not clear which one, Buddo leaves it to the model', () => {
  const two = { path: 'index.html', content: '<body>\n<button>A</button>\n<button>B</button>\n</body>' };
  assert.equal(quickChange('make the button red', { page: two }), null);
  assert.equal(quickChange('make the button red', { page: { path: 'index.html', content: '<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>' } }), null, 'a React app');
  assert.equal(quickChange('add a green button', { empty: false }), null, 'no page, but the folder has other files');
  assert.equal(quickChange('make the button say Go', { page: { path: 'index.html', content: '<body>\n<button><i class="icon"></i> Send</button>\n</body>' } }), null, 'a button with an icon in it');
});

test('only the newest copy of a pasted file stays in what the model reads', () => {
  const file = (v) => `[Current index.html]\n\`\`\`html\n<p>${v}</p>\n\`\`\``;
  const msgs = [
    { role: 'user', content: `make it blue\n\n${file('v1')}\nChange only what was asked.` },
    { role: 'assistant', content: 'Here:\n```html\n<p style="color:blue">v1</p>\n```\n\n[Buddo saved these code blocks as files: index.html (edited)]' },
    { role: 'user', content: `make it bigger\n\n${file('v2')}\nChange only what was asked.` },
  ];
  const slim = slimHistory(msgs);
  assert.equal(slim[0].content, 'make it blue\n\n[an older copy of index.html was shown here]\nChange only what was asked.');
  assert.match(slim[1].content, /\[this code was saved into the files\]/);
  assert.equal(slim[2].content, msgs[2].content, 'the newest copy is kept');
  assert.equal(msgs[0].content.includes('v1'), true, 'the saved chat itself is untouched');
});
