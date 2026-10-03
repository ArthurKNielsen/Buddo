import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent, extractCodeFiles, executeTool } from '../src/index.js';
import { removalKind, keepOnlyRemovals, deleteListedLines, isMinusList } from '../src/edits.js';
import { linkAssets } from '../src/codeblocks.js';
import { createNodeWorkspace } from '../src/node-workspace.js';

// The page a tiny model made for "make a green button" (seen in a screen recording): far more than a button.
const PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>Green Button</title>
  <style>
    body { font-family: Arial; text-align: center; }
    h1 { color: #333; }
    .green-button { background-color: green; color: white; padding: 10px 20px; }
  </style>
</head>
<body>
  <h1>Welcome to my page</h1>
  <p>Click the button below to see magic.</p>
  <button class="green-button" onclick="showMessage()">Green</button>
  <p id="message"></p>
  <script>
    function showMessage() {
      document.getElementById('message').textContent = 'You clicked the green button!';
    }
  </script>
</body>
</html>
`;

async function chat(turns, { files = {}, lite = true, mode = 'auto' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-rm-'));
  for (const [k, v] of Object.entries(files)) await fs.writeFile(path.join(dir, k), v);
  const ws = createNodeWorkspace(dir);
  const seen = [];
  let i = 0;
  const provider = { async *stream({ messages }) { seen.push(messages); yield { type: 'text', text: turns[Math.min(i++, turns.length - 1)] }; } };
  const events = [];
  const messages = [{ role: 'user', content: turns.prompt }];
  const res = await runAgent({ provider, model: 'llama-3.2-1b', workspace: ws, messages, mode, lite, onEvent: (e) => events.push(e) });
  return { res, events, seen, messages, read: (f) => fs.readFile(path.join(dir, f), 'utf8') };
}

/** Every line of `after` is a line of `before`, in order: the change only deleted lines. */
function onlyDeleted(before, after) {
  const A = before.split('\n');
  let i = 0;
  for (const l of after.split('\n')) {
    while (i < A.length && A[i] !== l) i++;
    if (i++ >= A.length) return false;
  }
  return true;
}

test('removal requests: what goes vs. what stays, and requests that ask for more', () => {
  assert.equal(removalKind('remove everything except the green button'), 'keep');
  assert.equal(removalKind('keep only the button'), 'keep');
  assert.equal(removalKind('delete the heading'), 'remove');
  assert.equal(removalKind('Can you get rid of the paragraph?'), 'remove');
  assert.equal(removalKind('remove the blue background'), 'remove');
  assert.equal(removalKind('remove the title and make the button blue'), null);
  assert.equal(removalKind('how do I remove the heading?'), null);
  assert.equal(removalKind('make a green button'), null);
  assert.equal(removalKind('rewrite it from scratch'), null);
});

test('keepOnlyRemovals: a rewrite only takes lines out; restyled lines stay as they were', () => {
  const rewrite = `<!DOCTYPE html>
<html>
<head>
<title>Green Button</title>
<style>
.green-button { background-color: #28a745; color: white; padding: 12px 24px; border-radius: 8px; }
</style>
</head>
<body>
<button class="green-button">Click me</button>
</body>
</html>
`;
  const out = keepOnlyRemovals(PAGE, rewrite);
  assert.ok(onlyDeleted(PAGE, out), 'nothing but deletions');
  assert.match(out, /    \.green-button \{ background-color: green; color: white; padding: 10px 20px; \}/, 'original style kept');
  assert.match(out, /<button class="green-button" onclick="showMessage\(\)">Green<\/button>/, 'original button kept');
  assert.doesNotMatch(out, /<h1>|<p>|<script>|h1 \{/);
  assert.equal(keepOnlyRemovals(PAGE, PAGE), null, 'sent back unchanged → nothing removed');
  assert.equal(keepOnlyRemovals(PAGE, PAGE.replace(/^\s+/gm, '')), null, 'only re-indented → nothing removed');
  // Cutting an attribute out of a line is a removal too.
  const cut = keepOnlyRemovals(PAGE, PAGE.replace(' onclick="showMessage()"', ''));
  assert.equal(cut, PAGE.replace(' onclick="showMessage()"', ''));
});

test('deleteListedLines: "- " lines, diffs and quoted lines; unknown lines are refused', () => {
  assert.ok(isMinusList('- <h1>Welcome to my page</h1>'));
  assert.ok(!isMinusList('.a { -webkit-appearance: none; }'));
  assert.equal(deleteListedLines(PAGE, '- <h1>Welcome to my page</h1>\n- <p>Click the button below to see magic.</p>'), PAGE.replace('  <h1>Welcome to my page</h1>\n  <p>Click the button below to see magic.</p>\n', ''));
  assert.equal(deleteListedLines(PAGE, '@@ -11,4 +11,3 @@\n <body>\n-  <h1>Welcome to my page</h1>\n   <p>Click the button below to see magic.</p>'), PAGE.replace('  <h1>Welcome to my page</h1>\n', ''));
  assert.equal(deleteListedLines(PAGE, '<h1>Welcome to my page</h1>'), PAGE.replace('  <h1>Welcome to my page</h1>\n', ''));
  assert.equal(deleteListedLines(PAGE, '- <h2>Not there</h2>'), null);
  assert.equal(deleteListedLines('<p>a</p>\n<p>b</p>\n<p>a</p>\n', '- <p>a</p>'), null, 'a line that appears twice is not guessed');
  assert.equal(deleteListedLines('<p>a</p>\n<p>b</p>\n<p>a</p>\n', '<p>b</p>\n- <p>a</p>'), '<p>a</p>\n<p>b</p>\n', '…unless a line above pins it down');
});

test('"make a green button": the CSS the model put in its own block is linked, so the button is actually green', () => {
  const reply = 'Here is a green button:\n\n```html\n<!DOCTYPE html>\n<html>\n<head>\n  <title>Button</title>\n</head>\n<body>\n  <button class="green-btn">Green</button>\n</body>\n</html>\n```\n\n```css\n.green-btn {\n  background-color: green;\n  color: white;\n}\n```\n\n```js\nconst button = document.querySelector(".green-btn");\nbutton.addEventListener("click", () => {\n  alert("hi");\n});\n```';
  const files = linkAssets(extractCodeFiles(reply, { wantsCode: true }));
  const page = files.find((f) => f.path === 'index.html').content;
  assert.match(page, /  <link rel="stylesheet" href="styles\.css">\n<\/head>/);
  assert.match(page, /  <script src="script\.js"><\/script>\n<\/body>/);
  // Already linked → left alone.
  const linked = linkAssets([{ path: 'index.html', lang: 'html', content: page }, { path: 'styles.css', lang: 'css', content: 'a{}' }]);
  assert.equal(linked[0].content, page);
});

test('"make a green button" end to end: page + separate CSS → the page loads the CSS', async () => {
  const turns = ['```html\n<!DOCTYPE html>\n<html>\n<head>\n<title>Button</title>\n</head>\n<body>\n<button class="green-btn">Green</button>\n</body>\n</html>\n```\n\n```css\n.green-btn {\n  background-color: green;\n}\n```'];
  turns.prompt = 'make a green button';
  const r = await chat(turns);
  assert.equal(r.res.status, 'done');
  assert.match(await r.read('index.html'), /<link rel="stylesheet" href="styles\.css">/);
  assert.match(await r.read('styles.css'), /background-color: green/);
});

test('"remove everything except the green button": the page sent back unchanged is never reported as done', async () => {
  const turns = [`I removed everything except the green button:\n\n\`\`\`html\n${PAGE}\`\`\``];
  turns.prompt = 'remove everything except the green button';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  // The model was told nothing changed and asked again…
  assert.match(r.seen[1].at(-1).content, /Nothing changed: your index\.html is exactly the same as the current file, so nothing was removed/);
  // …and when it still changed nothing, the user is told so plainly.
  assert.equal(r.res.status, 'error');
  const err = r.events.find((e) => e.type === 'error');
  assert.match(err.error, /^Nothing was changed: .*same as index\.html.*The reply says the change was made, but it was not\./);
  assert.ok(!r.events.some((e) => e.type === 'done'), 'never "done"');
  assert.equal(await r.read('index.html'), PAGE);
  assert.match(r.messages.at(-1).content, /\[Buddo: nothing was saved, the files are unchanged/);
});

test('"remove everything except the green button": a restyled rewrite only deletes lines', async () => {
  const rewrite = `<!DOCTYPE html>
<html>
<head>
<title>Green Button</title>
<style>
.green-button { background-color: #28a745; color: white; padding: 12px 24px; border-radius: 8px; }
</style>
</head>
<body>
<button class="green-button">Click me</button>
</body>
</html>
`;
  const turns = [`index.html\n\`\`\`html\n${rewrite}\`\`\``];
  turns.prompt = 'remove everything except the green button';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.res.status, 'done');
  // The small model was asked for just what stays.
  assert.match(r.seen[0].at(-1).content, /\[Current index\.html\][\s\S]*only the lines that stay, copied exactly/);
  const after = await r.read('index.html');
  assert.ok(onlyDeleted(PAGE, after), 'every line left is an original line');
  assert.match(after, /background-color: green; color: white; padding: 10px 20px;/);
  assert.doesNotMatch(after, /<h1>|<p|<script>|#28a745|Click me/);
  assert.ok(r.events.filter((e) => e.type === 'tool-start').every((e) => e.call.name === 'edit_file'), 'saved as line edits');
});

test('"remove the heading": the lines to delete come back with "- " and only they go', async () => {
  const turns = ['index.html\n```html\n- <h1>Welcome to my page</h1>\n```'];
  turns.prompt = 'remove the heading';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.res.status, 'done');
  assert.match(r.seen[0].at(-1).content, /ONLY the lines to delete, copied exactly from the file, each starting with "- "/);
  assert.equal(await r.read('index.html'), PAGE.replace('  <h1>Welcome to my page</h1>\n', ''));
  assert.equal(r.seen.length, 1, 'one model call');
});

test('"remove the heading": a reply that is just the button is not guessed; asked again, then applied', async () => {
  const turns = ['index.html\n```html\n<button class="green-button" onclick="showMessage()">Green</button>\n<h2>new</h2>\n```', 'index.html\n```diff\n- <h1>Welcome to my page</h1>\n```'];
  turns.prompt = 'remove the heading';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.res.status, 'done');
  assert.match(r.seen[1].at(-1).content, /couldn't tell which lines to delete/);
  assert.equal(await r.read('index.html'), PAGE.replace('  <h1>Welcome to my page</h1>\n', ''));
});

test("Buddo's own nudges are never read as the request (\"…which lines to delete\" must not delete the button)", async () => {
  const kept = PAGE.split('\n').filter((l) => !/<h1>|<p|<script>|function|getElementById|^\s+}$|<\/script>|h1 \{|body \{/.test(l)).join('\n');
  const button = 'index.html\n```html\n<button class="green-button" onclick="showMessage()">Green</button>\n```';
  const turns = [button, button, `\`\`\`html\n${kept}\`\`\``];
  turns.prompt = 'remove everything except the green button';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.res.status, 'done');
  assert.match(r.seen[1].at(-1).content, /couldn't tell which lines to delete[\s\S]*only the lines that stay/);
  assert.match(r.seen[2].at(-1).content, /COMPLETE index\.html as it should end up/);
  const after = await r.read('index.html');
  assert.match(after, /<button class="green-button" onclick="showMessage\(\)">Green<\/button>/, 'the button stays');
  assert.ok(onlyDeleted(PAGE, after));
  assert.doesNotMatch(after, /<h1>|<p/);
});

test('tool-calling model: a whole-file rewrite for a removal saves only the removed lines', async () => {
  const rewrite = PAGE.replace('  <h1>Welcome to my page</h1>\n', '').replace('padding: 10px 20px;', 'padding: 30px;').replace('>Green<', '>Go<');
  const turns = [`<tool:write_file>\n<path>index.html</path>\n<content>\n${rewrite}</content>\n</tool:write_file>`, 'Removed the heading.'];
  turns.prompt = 'remove the heading';
  const r = await chat(turns, { files: { 'index.html': PAGE }, lite: false });
  assert.equal(r.res.status, 'done');
  assert.equal(await r.read('index.html'), PAGE.replace('  <h1>Welcome to my page</h1>\n', ''), 'restyle and new text were not saved');
  assert.match(r.seen[1].at(-1).content, /Only the removed lines were saved/);
});

test('tool-calling model: a "removal" rewrite that removes nothing is refused', async () => {
  const turns = [`<tool:write_file>\n<path>index.html</path>\n<content>\n${PAGE}</content>\n</tool:write_file>`, 'ok'];
  turns.prompt = 'remove the heading';
  const r = await chat(turns, { files: { 'index.html': PAGE }, lite: false });
  assert.match(r.seen[1].at(-1).content, /Nothing was removed: that rewrite of index\.html still has every line/);
  assert.equal(await r.read('index.html'), PAGE);
});

test('a model that only claims it made the change is not believed', async () => {
  const turns = ['Done! I removed everything except the green button.'];
  turns.prompt = 'remove everything except the green button';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.match(r.seen[1].at(-1).content, /^Nothing in the project changed yet: no code was written/);
  assert.equal(r.res.status, 'error');
  assert.match(r.events.find((e) => e.type === 'error').error, /Nothing was changed: the model wrote no code\. The reply says the change was made, but it was not\./);
  assert.equal(await r.read('index.html'), PAGE);
});

test('find/replace edits that never apply end in an error, not "done"', async () => {
  const turns = ['index.html\n<<<<<<< SEARCH\nnope\n=======\nstill nope\n>>>>>>> REPLACE'];
  turns.prompt = 'Make the button blue';
  const r = await chat(turns, { files: { 'index.html': PAGE } });
  assert.equal(r.res.status, 'error');
  assert.ok(!r.events.some((e) => e.type === 'done'));
  assert.match(r.events.find((e) => e.type === 'error').error, /^Nothing was changed: /);
});

test('edit_file deleting whole lines leaves no blank line behind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-rm-'));
  await fs.writeFile(path.join(dir, 'index.html'), PAGE);
  const workspace = createNodeWorkspace(dir);
  const r = await executeTool({ name: 'edit_file', args: { path: 'index.html', old: '<h1>Welcome to my page</h1>', new: '' } }, { workspace });
  assert.ok(r.ok);
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), PAGE.replace('  <h1>Welcome to my page</h1>\n', ''));
  await executeTool({ name: 'edit_file', args: { path: 'index.html', old: ' onclick="showMessage()"', new: '' } }, { workspace });
  assert.match(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), /<button class="green-button">Green<\/button>/, 'part of a line: just that part');
});
