import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeCss, mergeCssIntoHtml, planCodeSave, looksLikeEdit, isNewBuild, sniffLang, extractCodeFiles, asksForCode, runAgent } from '../src/index.js';
import { createNodeWorkspace } from '../src/node-workspace.js';

const PAGE = `<!DOCTYPE html>
<html>
<head>
<style>
body {
  display: flex;
  justify-content: center;
}
.button {
  padding: 10px 20px;
  background-color: #4CAF50;
}
</style>
</head>
<body>
<h1>Button Example</h1>
<button class="button">Click Me</button>
<script>
document.querySelector('.button').addEventListener('click', () => alert('hi'));
</script>
</body>
</html>
`;

test('CSS fragments merge rule by rule', () => {
  const out = mergeCss('body {\n  margin: 0;\n  color: red;\n}\n.a { x: 1 }\n', 'body { color: blue; flex-direction: column; }\n.new { y: 2; }');
  assert.match(out, /body \{\n  margin: 0;\n  color: blue;\n  flex-direction: column;\n\}/);
  assert.match(out, /\.a \{ x: 1 \}/);
  assert.match(out, /\.new \{ y: 2; \}\n$/);
  const html = mergeCssIntoHtml(PAGE, '.button { background-color: blue; }');
  assert.match(html, /\.button \{\n  padding: 10px 20px;\n  background-color: blue;\n\}/);
  assert.equal((html.match(/<style>/g) || []).length, 1);
  assert.match(mergeCssIntoHtml('<html><head></head><body></body></html>', 'p{a:b}'), /<style>\np\{a:b\}\n<\/style>\n<\/head>/);
});

test('language sniffing and request detection', () => {
  assert.equal(sniffLang('<!DOCTYPE html>\n<html></html>'), 'html');
  assert.equal(sniffLang('.button {\n  color: red;\n}'), 'css');
  assert.equal(sniffLang("document.querySelector('a').onclick = () => {};"), 'js');
  assert.equal(sniffLang('def main():\n    print(1)'), 'py');
  assert.equal(sniffLang('Hello, World!'), '');
  assert.ok(looksLikeEdit('Make the button blue'));
  assert.ok(looksLikeEdit('move the button under the text'));
  assert.ok(!looksLikeEdit('make me a snake game'));
  assert.ok(isNewBuild('Make a website with a button'));
  assert.ok(asksForCode('I want a calculator website'));
  assert.ok(!asksForCode('what is a website?'));
  // unlabeled fences get a language from their content
  const f = extractCodeFiles('Here:\n```\n<!DOCTYPE html>\n<html><body><button>Hi</button></body></html>\n```', { wantsCode: true });
  assert.deepEqual(f.map((x) => x.path), ['index.html']);
});

test('planCodeSave: full page replaces the edited page; fragments merge or ask for the whole file', async () => {
  const target = { path: 'buttons.html', content: PAGE };
  const read = async (p) => (p === 'buttons.html' ? PAGE : null);
  const full = await planCodeSave([{ path: 'index.html', inferred: true, lang: 'html', content: PAGE.replace('#4CAF50', 'blue') }], { target, edit: true, read });
  assert.equal(full.writes[0].path, 'buttons.html', 'keeps the name of the page being edited');
  const css = await planCodeSave([{ path: 'styles.css', inferred: true, lang: 'css', content: '.button { background-color: blue; }' }], { target, edit: true, read });
  assert.equal(css.writes[0].path, 'buttons.html');
  assert.match(css.writes[0].content, /background-color: blue/);
  assert.ok(css.writes[0].merged);
  const js = await planCodeSave([{ path: 'script.js', inferred: true, lang: 'js', content: "alert('x')" }], { target, edit: true, read });
  assert.deepEqual(js, { writes: [], needFull: true });
  const fresh = await planCodeSave([{ path: 'script.js', inferred: true, lang: 'js', content: "alert('x')" }], { target: null, read });
  assert.equal(fresh.writes.length, 1, 'no page yet: save as a new file');
});

async function chat(turns, { files = {}, lite = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-edit-'));
  for (const [k, v] of Object.entries(files)) await fs.writeFile(path.join(dir, k), v);
  const ws = createNodeWorkspace(dir);
  const seen = [];
  let i = 0;
  const provider = { async *stream({ messages }) { seen.push(messages); yield { type: 'text', text: turns[Math.min(i++, turns.length - 1)] }; } };
  const events = [];
  const messages = [{ role: 'user', content: turns.prompt }];
  const res = await runAgent({ provider, model: 'llama-3.2-1b', workspace: ws, messages, mode: 'auto', lite, onEvent: (e) => events.push(e) });
  return { res, events, seen, dir, read: (f) => fs.readFile(path.join(dir, f), 'utf8') };
}

test('edit request: small model sees the current page, its CSS fragment is merged', async () => {
  const turns = ['Sure! Change the button color like this:\n\n```css\n.button {\n  background-color: blue;\n}\n```'];
  turns.prompt = 'Make the button blue';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.res.status, 'done');
  assert.match(r.seen[0].at(-1).content, /\[Current index\.html\]\n```html\n<!DOCTYPE html>/, 'current file attached');
  const html = await r.read('index.html');
  assert.match(html, /background-color: blue/);
  assert.match(html, /<h1>Button Example<\/h1>/, 'rest of the page kept');
  await assert.rejects(r.read('styles.css'), 'no stray new file');
});

test('edit request: a JS snippet makes Buddo ask for the whole file, then saves it', async () => {
  const fixed = PAGE.replace("alert('hi')", "alert('Hello!')");
  const turns = ["Replace the click handler with:\n\n```javascript\ndocument.querySelector('.button').addEventListener('click', () => alert('Hello!'));\n```", `Here is the complete file:\n\n\`\`\`html\n${fixed}\`\`\``];
  turns.prompt = 'Change the alert text to Hello!';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.res.status, 'done');
  assert.equal(r.events.filter((e) => e.type === 'nudge' && /only part/.test(e.text)).length, 1);
  assert.match(await r.read('index.html'), /alert\('Hello!'\)/);
  await assert.rejects(r.read('script.js'));
});

test('Llama JSON tool call writes the file', async () => {
  const turns = [JSON.stringify({ name: 'write_file', parameters: { path: 'index.html', content: '<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>' } }), 'Done!'];
  turns.prompt = 'Make a website that says hi';
  const r = await chat(turns);
  assert.equal(r.res.status, 'done');
  assert.match(await r.read('index.html'), /<h1>Hi<\/h1>/);
  assert.ok(!r.events.some((e) => e.type === 'text' && e.delta.includes('"name"')), 'the JSON is not shown as chat text');
});

test('only words for a code request: asks for the code once', async () => {
  const turns = ['To make a calculator you need buttons for digits and an equals sign.', '```html\n<!DOCTYPE html>\n<html><body><button>1</button></body></html>\n```'];
  turns.prompt = 'I want a calculator website';
  const r = await chat(turns);
  assert.equal(r.events.filter((e) => e.type === 'nudge').length, 1);
  assert.match(await r.read('index.html'), /<button>1<\/button>/);
});

test('new-thing requests are not treated as edits', () => {
  assert.ok(isNewBuild('I want a calculator website'));
  assert.ok(isNewBuild('give me a todo app'));
  assert.ok(!isNewBuild('Make the button blue'));
});
