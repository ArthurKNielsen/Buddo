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
