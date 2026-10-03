import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeCss, mergeCssIntoHtml, planCodeSave, looksLikeEdit, isNewBuild, sniffLang, extractCodeFiles, asksForCode, runAgent, parseFindReplace } from '../src/index.js';
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

test('edit request: a JS snippet is spliced into the page where it belongs (one call)', async () => {
  const turns = ["Replace the click handler with:\n\n```javascript\ndocument.querySelector('.button').addEventListener('click', () => alert('Hello!'));\n```"];
  turns.prompt = 'Change the alert text to Hello!';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.res.status, 'done');
  assert.equal(await r.read('index.html'), PAGE.replace("alert('hi')", "alert('Hello!')"));
  assert.equal(r.seen.length, 1);
  await assert.rejects(r.read('script.js'));
});

test('edit request: a snippet that could go in several places → Buddo asks for the whole file', async () => {
  const fixed = PAGE.replace('<h1>Button Example</h1>', '<h1>Buttons</h1>');
  const turns = ['```html\n<p>Some new paragraph</p>\n```', `\`\`\`html\n${fixed}\`\`\``];
  turns.prompt = 'Change the text';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.events.filter((e) => e.type === 'nudge' && /only part/.test(e.text)).length, 1);
  assert.equal(await r.read('index.html'), fixed);
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

test('parseFindReplace: file name, fences, several blocks, missing end marker', () => {
  const one = parseFindReplace('Here you go:\n\nindex.html\n```html\n<<<<<<< SEARCH\n  background: white;\n=======\n  background: blue;\n>>>>>>> REPLACE\n```');
  assert.deepEqual(one, [{ path: 'index.html', find: '  background: white;', replace: '  background: blue;' }]);
  const two = parseFindReplace('**style.css**\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE');
  assert.deepEqual(two.map((c) => [c.path, c.find, c.replace]), [['style.css', 'a', 'b'], [null, 'c', 'd']]);
  const cut = parseFindReplace('<<<<<<< SEARCH\nx\n=======\ny\n```\n');
  assert.deepEqual(cut, [{ path: null, find: 'x', replace: 'y' }]);
  assert.deepEqual(parseFindReplace('a merge conflict?\n<<<<<<< HEAD\nno split'), []);
});

// Find/replace is only asked for on big files (small ones are rewritten whole in one reply).
const BIG = PAGE.replace('<h1>Button Example</h1>', `<h1>Button Example</h1>\n${Array.from({ length: 80 }, (_, n) => `<p>Paragraph ${n + 1} of the page.</p>`).join('\n')}`);

test('edit request: only the changed line comes back and lands in place (seen with tiny models on a Chromebook)', async () => {
  const turns = ['```html\n  background-color: green;\n```'];
  turns.prompt = 'Make the button green';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.res.status, 'done');
  assert.match(r.seen[0].at(-1).content, /ONLY the lines you change/);
  assert.equal(await r.read('index.html'), PAGE.replace('#4CAF50', 'green'));
  const edit = r.events.find((e) => e.type === 'tool-start' && e.call.name === 'edit_file');
  assert.ok(edit, 'shown as an edit, not an overwrite');
  assert.equal(edit.call.args.new, '  background-color: green;');
  assert.equal(r.seen.length, 1);
});

test('edit request: a whole page sent back anyway is still saved (one call)', async () => {
  const turns = [`\`\`\`html\n${PAGE.replace('#4CAF50', 'green')}\`\`\``];
  turns.prompt = 'Make the button green';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.res.status, 'done');
  assert.doesNotMatch(r.seen[0].at(-1).content, /<<<<<<< SEARCH/);
  assert.doesNotMatch(r.seen[0][0].content, /<<<<<<< SEARCH/, 'lite prompt stays short');
  assert.equal(await r.read('index.html'), PAGE.replace('#4CAF50', 'green'));
  assert.equal(r.seen.length, 1, 'one model call');
});

test('edit request: a find/replace reply changes only that line', async () => {
  const turns = ['index.html\n<<<<<<< SEARCH\n  background-color: #4CAF50;\n=======\n  background-color: blue;\n>>>>>>> REPLACE'];
  turns.prompt = 'Make the button blue';
  const r = await chat(turns, { files: { 'index.html': BIG } });
  assert.equal(r.res.status, 'done');
  assert.match(r.seen[0].at(-1).content, /ONLY the lines you change/, 'asked for just the change');
  assert.equal(await r.read('index.html'), BIG.replace('#4CAF50', 'blue'));
  assert.equal(r.seen.length, 1, 'one model call');
});

test('edit request: a find/replace that does not match is retried, then the whole file is asked for', async () => {
  const fixed = BIG.replace('#4CAF50', 'blue');
  const turns = ['<<<<<<< SEARCH\ncolor: green;\n=======\ncolor: blue;\n>>>>>>> REPLACE', '<<<<<<< SEARCH\nnope\n=======\nstill nope\n>>>>>>> REPLACE', `\`\`\`html\n${fixed}\`\`\``];
  turns.prompt = 'Make the button blue';
  const r = await chat(turns, { files: { 'index.html': BIG } });
  assert.equal(r.res.status, 'done');
  assert.match(r.seen[1].at(-1).content, /didn't apply[\s\S]*\[Current index\.html\]/);
  assert.match(r.seen[2].at(-1).content, /COMPLETE updated index\.html/);
  assert.equal(await r.read('index.html'), fixed);
});

test('edit request: markers copied without code (seen on a Chromebook) → shown an example, then the edit applies', async () => {
  const turns = ['<<<<<<< SEARCH / ======= / >>>>>>> REPLACE', 'index.html\n<<<<<<< SEARCH\n  background-color: #4CAF50;\n=======\n  background-color: green;\n>>>>>>> REPLACE'];
  turns.prompt = 'Make the button green';
  const r = await chat(turns, { files: { 'index.html': BIG } });
  assert.equal(r.res.status, 'done');
  assert.match(r.seen[1].at(-1).content, /had no code in it[\s\S]*<<<<<<< SEARCH\n/);
  assert.ok(r.events.some((e) => e.type === 'nudge' && /markers but no code/.test(e.text)));
  assert.equal(await r.read('index.html'), BIG.replace('#4CAF50', 'green'));
  assert.equal(r.seen.length, 2);
});

test('edit request: a copied example is never applied', async () => {
  const page = BIG.replace('<h1>Button Example</h1>', '<p>Old text</p>');
  const turns = ['index.html\n<<<<<<< SEARCH\n<p>Old text</p>\n=======\n<p>New text</p>\n>>>>>>> REPLACE', 'index.html\n<<<<<<< SEARCH\n  background-color: #4CAF50;\n=======\n  background-color: green;\n>>>>>>> REPLACE'];
  turns.prompt = 'Make the button green';
  const r = await chat(turns, { files: { 'index.html': page } });
  assert.match(r.seen[1].at(-1).content, /That was the example/);
  assert.equal(await r.read('index.html'), page.replace('#4CAF50', 'green'), 'only the real edit landed');
});
