import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agent.js';
import { createNodeWorkspace } from '../src/node-workspace.js';

const PAGE = '<!DOCTYPE html>\n<html><body><h1>My Portfolio</h1><p>Projects</p></body></html>';

/** A small model that apologises and writes index.html again after every save (the reported 3B loop). */
function looping({ drift = false } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async *stream() {
      calls++;
      const page = drift ? PAGE.replace('Projects', `Projects ${calls}`) : PAGE;
      yield { type: 'text', text: `${calls > 1 ? 'I apologize for the confusion. ' : ''}<tool:write_file>\n<path>index.html</path>\n<content>\n${page}\n</content>\n</tool:write_file>` };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

for (const drift of [false, true]) {
  test(`stops a model that keeps rewriting the same file${drift ? ' with small changes' : ''}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-loop-'));
    const provider = looping({ drift });
    const events = [];
    const res = await runAgent({ provider, model: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', workspace: createNodeWorkspace(dir), messages: [{ role: 'user', content: 'make a simple portfolio site' }], mode: 'auto', lite: true, onEvent: (e) => events.push(e) });
    assert.equal(res.status, 'done');
    assert.ok(provider.calls <= 3, `asked the model ${provider.calls} times`);
    assert.match(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /Done — index\.html is saved/);
    assert.match(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), /My Portfolio/);
    await fs.rm(dir, { recursive: true, force: true });
  });
}

/** The loop from the bug video: a todo list, read src/app.js (missing), "I apologize…", again. */
function readsMissing({ listens = false } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async *stream({ messages }) {
      calls++;
      const last = messages[messages.length - 1].content;
      if (listens && /does not exist/.test(last)) {
        yield { type: 'text', text: 'index.html\n```html\n<!DOCTYPE html>\n<html><body><h1>Coffee Shop</h1></body></html>\n```' };
      } else {
        yield { type: 'text', text: `${calls > 1 ? 'I apologize for the confusion. ' : 'Sure, let\'s get started! '}Todo\n1. Create index.html\n2. Create styles.css\n<tool:read_file>\n<path>src/app.js</path>\n</tool:read_file>` };
      }
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

test('a model stuck reading a missing file is stopped quickly, with a clear message', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-loop-'));
  const provider = readsMissing();
  const events = [];
  const res = await runAgent({ provider, model: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', workspace: createNodeWorkspace(dir), messages: [{ role: 'user', content: 'Build this from scratch: a modern animated landing page for a coffee shop.' }], mode: 'auto', lite: true, onEvent: (e) => events.push(e) });
  assert.equal(res.status, 'error');
  assert.ok(provider.calls <= 3, `asked the model ${provider.calls} times`);
  assert.match(events.find((e) => e.type === 'error').error, /read files that don't exist \(src\/app\.js\)/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('told the file is missing and the project empty, the model writes the site', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-loop-'));
  const provider = readsMissing({ listens: true });
  const res = await runAgent({ provider, model: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', workspace: createNodeWorkspace(dir), messages: [{ role: 'user', content: 'Build this from scratch: a modern animated landing page for a coffee shop.' }], mode: 'auto', lite: true, onEvent: () => {} });
  assert.equal(res.status, 'done');
  assert.equal(provider.calls, 2);
  assert.match(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), /Coffee Shop/);
  const hint = res.messages.find((m) => /does not exist/.test(m.content)).content;
  assert.match(hint, /The project is empty/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('after writing the site, a model that goes back to its todo list finishes as done', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-loop-'));
  let calls = 0;
  const files = [
    ['index.html', '<!DOCTYPE html>\n<html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Brew & Bean</h1></body></html>'],
    ['styles.css', 'body { background: #f5e6d3; }'],
  ];
  const provider = {
    async *stream() {
      calls++;
      const f = files[calls - 1];
      yield {
        type: 'text',
        text: f
          ? `<tool:write_file>\n<path>${f[0]}</path>\n<content>\n${f[1]}\n</content>\n</tool:write_file>`
          : 'Todo\n<tool:todo>\n<items>\n[ ] Create index.html\n[ ] Create styles.css\n</items>\n</tool:todo>',
      };
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const events = [];
  const res = await runAgent({ provider, model: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', workspace: createNodeWorkspace(dir), messages: [{ role: 'user', content: 'Build this from scratch: a landing page for a coffee shop.' }], mode: 'auto', lite: true, onEvent: (e) => events.push(e) });
  assert.equal(res.status, 'done', events.find((e) => e.type === 'error')?.error);
  assert.ok(!events.some((e) => e.type === 'error'), 'no error at the end');
  assert.match(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /Done — saved index\.html, styles\.css/);
  assert.ok(calls <= 4, `asked the model ${calls} times`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('files written as code blocks are saved before the model reads them back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-loop-'));
  let calls = 0;
  const seenResults = [];
  const provider = {
    async *stream({ messages }) {
      calls++;
      const last = messages[messages.length - 1].content;
      if (calls > 1) seenResults.push(last);
      // Writes the page, then checks it — in the same reply. Without the file it would write it again, forever.
      const text = calls === 1 || /not exist|not found/i.test(last)
        ? 'index.html\n```html\n<!DOCTYPE html>\n<html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Brew & Bean</h1></body></html>\n```\n\nstyles.css\n```css\nbody { background: #f5e6d3; }\n```\n\nLet me check the page.\n<tool:read_file>\n<path>index.html</path>\n</tool:read_file>'
        : 'The coffee shop page is ready.';
      yield { type: 'text', text };
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const res = await runAgent({ provider, model: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', workspace: createNodeWorkspace(dir), messages: [{ role: 'user', content: 'Build this from scratch: a landing page for a coffee shop.' }], mode: 'auto', lite: true, onEvent: () => {} });
  assert.equal(res.status, 'done');
  assert.equal(calls, 2, 'one reply to build, one to wrap up');
  assert.match(seenResults[0], /Buddo saved the code blocks you wrote as files: index\.html, styles\.css/);
  assert.match(seenResults[0], /Brew & Bean/, 'the read found the page');
  assert.match(await fs.readFile(path.join(dir, 'styles.css'), 'utf8'), /f5e6d3/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a CSS rule labelled as the page is merged into its <style>, first try', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-css-'));
  const page = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>5 Dog Breeds</title>\n  <style>\n    body {\n      font-family: Arial, sans-serif;\n      background-color: red;\n    }\n    h1 {\n      color: white;\n      font-size: 40px;\n    }\n  </style>\n</head>\n<body>\n  <h1>Popular Dog Breeds</h1>\n  <div class="breed"><h2>Golden Retriever</h2></div>\n</body>\n</html>\n';
  await fs.writeFile(path.join(dir, 'index.html'), page);
  let calls = 0;
  // What the 7B coder sent in the bug video: just the rule, under "index.html".
  const provider = { async *stream() { calls++; yield { type: 'text', text: 'index.html\n```html\nh1 {\n    color: green;\n}\n```' }; yield { type: 'finish', reason: 'stop' }; } };
  const events = [];
  const res = await runAgent({ provider, model: 'qwen2.5-coder:7b', workspace: createNodeWorkspace(dir), messages: [{ role: 'user', content: 'change the color of "Popular Dog Breeds" to green' }], mode: 'auto', lite: false, onEvent: (e) => events.push(e) });
  assert.equal(res.status, 'done');
  assert.equal(calls, 1, 'no "couldn\'t place the lines", no asking for the whole file');
  assert.ok(!events.some((e) => e.type === 'nudge'), events.filter((e) => e.type === 'nudge').map((e) => e.text).join(' | '));
  const after = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(after, /h1 \{\n\s+color: green;\n\s+font-size: 40px;\n\s+\}/, 'the existing rule is updated, its other properties kept');
  assert.equal((after.match(/h1 \{/g) || []).length, 1, 'no duplicate rule');
  assert.match(after, /<h1>Popular Dog Breeds<\/h1>/);
  assert.equal(after.replace(/h1 \{[^}]*\}/, '').length, page.replace(/h1 \{[^}]*\}/, '').length, 'nothing else changed');
  await fs.rm(dir, { recursive: true, force: true });
});
