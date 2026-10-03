import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractCodeFiles, isRefusal, asksForCode, findToolCall, runAgent } from '../src/index.js';
import { createNodeWorkspace } from '../src/node-workspace.js';

const PAGE = '<!DOCTYPE html>\n<html>\n<head><link rel="stylesheet" href="style.css"></head>\n<body><h1>Hi</h1><script src="app.js"></script></body>\n</html>';

test('extracts files from markdown code blocks', () => {
  const text = `Here you go!\n\n\`\`\`html\n${PAGE}\n\`\`\`\n\n\`\`\`css\nbody { margin: 0; }\nh1 { color: red; }\n.a { x: 1 }\n.b { y: 2 }\n\`\`\`\n\n**app.js**\n\`\`\`js\nconsole.log(1)\n\`\`\`\n\nRun it:\n\`\`\`bash\nopen index.html\n\`\`\``;
  const files = extractCodeFiles(text);
  assert.deepEqual(files.map((f) => f.path), ['index.html', 'style.css', 'app.js']);
  assert.equal(files[0].inferred, true);
  assert.equal(files[2].inferred, false);
  assert.match(extractCodeFiles('```python\n# game.py\nprint(1)\n```')[0].path, /^game\.py$/);
  assert.equal(extractCodeFiles('Use `x.map()`:\n```js\nx.map(f)\n```').length, 0, 'tiny unnamed snippets are examples');
  assert.equal(extractCodeFiles('```html:pages/a.html\n<p>a</p>\n```')[0].path, 'pages/a.html');
  assert.equal(extractCodeFiles('```html\n<!doctype html>\n<p>cut off')[0].truncated, true);
});

test('detects refusals and code requests', () => {
  assert.ok(isRefusal("I'm sorry, but I can't create files on your computer."));
  assert.ok(isRefusal('As an AI language model, I cannot write code to your device.'));
  assert.ok(isRefusal("I don't have the ability to save files."));
  assert.ok(!isRefusal('I created index.html with a red button.'));
  assert.ok(asksForCode('make me a snake game'));
  assert.ok(!asksForCode('what is a closure?'));
});

test('parser accepts tool tags without the tool: prefix, but not HTML', () => {
  const c = findToolCall('<write_file>\n<path>a.html</path>\n<content>\n<p>x</p>\n</content>\n</write_file>');
  assert.equal(c.name, 'write_file');
  assert.deepEqual(c.args, { path: 'a.html', content: '<p>x</p>' });
  assert.equal(findToolCall('<search><input placeholder="q"></search>'), null);
});

async function run(script, { mode = 'auto', ask = 'allow', prompt = 'make me a website with a button' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-cb-'));
  const ws = createNodeWorkspace(dir);
  let i = 0;
  const seen = [];
  const provider = {
    async *stream({ messages }) {
      seen.push(messages.map((m) => m.content));
      yield { type: 'text', text: script[Math.min(i++, script.length - 1)] };
    },
  };
  const events = [];
  const asked = [];
  const res = await runAgent({
    provider, model: 'qwen2.5-coder-0.5b', workspace: ws, messages: [{ role: 'user', content: prompt }], mode,
    onEvent: (e) => events.push(e), askPermission: async (call) => (asked.push(call), ask),
  });
  const exists = async (f) => fs.readFile(path.join(dir, f), 'utf8').catch(() => null);
  return { res, events, asked, exists, seen, calls: i };
}

test('agent saves code blocks from models that skip tool calls', async () => {
  const r = await run([`Sure! Here is your page:\n\n\`\`\`html\n${PAGE}\n\`\`\`\n\n\`\`\`css\nbody { margin: 0; }\nh1 { color: red; }\nbutton { padding: 8px; }\n\`\`\``]);
  assert.equal(r.res.status, 'done');
  assert.match(await r.exists('index.html'), /<h1>Hi<\/h1>/);
  assert.match(await r.exists('style.css'), /color: red/);
  const starts = r.events.filter((e) => e.type === 'tool-start');
  assert.ok(starts.every((e) => e.call.auto && e.call.name === 'write_file'));
  assert.equal(r.events.filter((e) => e.type === 'tool-end' && e.ok).length, 2);
});

test('auto-saved code blocks still need approval in ask mode', async () => {
  const r = await run([`\`\`\`html\n${PAGE}\n\`\`\``], { mode: 'ask', ask: 'deny' });
  assert.equal(r.asked.length, 1);
  assert.equal(await r.exists('index.html'), null);
});

test('plan mode and plain questions never save files', async () => {
  const p = await run([`\`\`\`html\n${PAGE}\n\`\`\``], { mode: 'plan' });
  assert.equal(await p.exists('index.html'), null);
  const q = await run(['A closure keeps variables alive:\n```js\nfunction a() {\n  let x = 1;\n  return () => x;\n}\n```'], { prompt: 'what is a closure?' });
  assert.equal(await q.exists('script.js'), null, 'inferred names only when the user asked for code');
});

test('a refusal gets one nudge, then the code is saved', async () => {
  const r = await run(["I'm sorry, but as an AI I can't create files on your computer.", `index.html\n\`\`\`html\n${PAGE}\n\`\`\``]);
  assert.equal(r.events.filter((e) => e.type === 'nudge').length, 1);
  assert.match(r.seen[1].at(-1), /You CAN do this/);
  assert.match(await r.exists('index.html'), /<h1>Hi<\/h1>/);
  const twice = await run(["I can't write files.", "I can't write files."]);
  assert.equal(twice.calls, 2, 'nudges only once');
  assert.equal(twice.res.status, 'done');
});

test('lite prompt tells tiny models they can write files', async () => {
  const { buildSystemPrompt } = await import('../src/index.js');
  const p = buildSystemPrompt({ lite: true, workspace: { name: 'x', capabilities: {} } });
  assert.match(p, /You CAN create and change files/);
  assert.match(p, /```html/);
  assert.doesNotMatch(buildSystemPrompt({ lite: true, mode: 'plan', workspace: { name: 'x', capabilities: {} } }), /You CAN create/);
});
