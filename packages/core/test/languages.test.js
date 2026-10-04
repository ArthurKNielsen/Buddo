import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent, requestedLanguage, isNewBuild, buildSystemPrompt } from '../src/index.js';
import { createNodeWorkspace } from '../src/node-workspace.js';

const PAGE = '<!DOCTYPE html>\n<html>\n<head>\n  <title>Site</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n  <h1>My site</h1>\n  <button>Go</button>\n</body>\n</html>\n';

async function chat(prompt, reply, { files = { 'index.html': PAGE, 'styles.css': 'h1 { color: red; }\n' }, history = [], lite = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-lang-'));
  for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(dir, f), c);
  const ws = createNodeWorkspace(dir);
  const replies = [].concat(reply);
  let i = 0;
  const seen = [];
  const provider = {
    async *stream({ messages }) {
      seen.push(messages[messages.length - 1].content);
      yield { type: 'text', text: replies[Math.min(i++, replies.length - 1)] };
    },
  };
  const events = [];
  const res = await runAgent({ provider, model: 'qwen2.5-coder:7b', workspace: ws, messages: [...history, { role: 'user', content: prompt }], mode: 'yolo', lite, onEvent: (e) => events.push(e) });
  const read = (f) => fs.readFile(path.join(dir, f), 'utf8').catch(() => null);
  return { res, events, read, seen, calls: i };
}

test('knows which language a message asks for', () => {
  assert.equal(requestedLanguage('write a python script that sorts a list'), 'py');
  assert.equal(requestedLanguage('can you make hello.py'), 'py');
  assert.equal(requestedLanguage('make a snake game in pygame'), 'py');
  assert.equal(requestedLanguage('write a Java program'), 'java');
  assert.equal(requestedLanguage('make me a website'), null);
  assert.equal(requestedLanguage('add some javascript to the button'), null);
  assert.equal(requestedLanguage('make the button green'), null);
  assert.ok(isNewBuild('write python code that prints the time'));
  assert.ok(isNewBuild('create calc.py'));
  assert.ok(!isNewBuild('fix the bug in my python script'));
});

test('a Python request in a chat with a web page makes a .py file and leaves the page alone', async () => {
  const code = 'def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        print(a)\n        a, b = b, a + b\n\nfib(10)';
  const { read, res } = await chat('write a python script that prints the fibonacci numbers', `Here you go:\n\n\`\`\`python\n${code}\n\`\`\``);
  assert.equal(res.status, 'done');
  assert.equal((await read('main.py')).trim(), code);
  assert.equal(await read('index.html'), PAGE);
});

test('a Python request without "a"/"new" (no make-me-a phrasing) still makes a file', async () => {
  const code = 'import time\n\nwhile True:\n    print(time.strftime("%H:%M:%S"))\n    time.sleep(1)';
  const { read } = await chat('python code that shows the time every second', `\`\`\`python\n${code}\n\`\`\``);
  assert.equal((await read('main.py')).trim(), code);
  assert.equal(await read('index.html'), PAGE);
});

test('asked for Python but got a web page: asks the model again for the .py file', async () => {
  const code = 'name = input("Name? ")\nprint(f"Hi {name}")\nprint("Bye")';
  const { read, seen } = await chat('write a python program that greets me', [`\`\`\`html\n<!DOCTYPE html>\n<html><body><p>Hi</p></body></html>\n\`\`\``, `main.py\n\`\`\`python\n${code}\n\`\`\``], { files: {} });
  assert.match(seen[1], /\.py file/);
  assert.equal((await read('main.py')).trim(), code);
  assert.equal(await read('index.html'), null);
});

test('fixing the Python script edits the .py file, not the page', async () => {
  const before = 'import sys\n\n\ndef add(a, b):\n    return a - b\n\n\ndef sub(a, b):\n    return a - b\n\n\ndef main():\n    print(add(2, 3))\n    print(sub(5, 1))\n\n\nmain()\n';
  const { read } = await chat('fix the bug in main.py, add should add', 'main.py\n```python\ndef add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n```', { files: { 'index.html': PAGE, 'main.py': before } });
  assert.equal(await read('main.py'), before.replace('a - b', 'a + b'));
  assert.equal(await read('index.html'), PAGE);
});

test('named shell scripts are saved, unnamed commands are not', async () => {
  const { read } = await chat('write a bash script that backs up my folder', 'backup.sh\n```bash\n#!/bin/bash\ntar czf backup.tgz .\necho done\n```\n\nRun it with:\n```bash\nbash backup.sh\n```', { files: {} });
  assert.match(await read('backup.sh'), /tar czf/);
});

test('the prompts tell the model to use the asked-for language', () => {
  for (const lite of [false, true]) {
    const p = buildSystemPrompt({ workspace: { name: 'x', write: true }, files: [], lite });
    assert.match(p, /Python is a \.py file|a Python script is a \.py file/);
  }
});

test('a changed line that is in the file twice is placed between the lines around it', async () => {
  const { mergeChangedLines } = await import('../src/edits.js');
  const js = 'function add(a, b) {\n  return a - b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n\nmain();\n';
  assert.equal(mergeChangedLines(js, 'function add(a, b) {\n  return a + b;\n}').content, js.replace('a - b', 'a + b'));
});

test('the system prompt stays the same after files change (so local engines can reuse what they read)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-cache-'));
  const ws = createNodeWorkspace(dir);
  const systems = [];
  const lasts = [];
  const provider = {
    async *stream({ messages, options }) {
      systems.push(messages[0].content);
      lasts.push(messages[messages.length - 1].content);
      assert.equal(options.num_ctx, 8192);
      yield { type: 'text', text: 'main.py\n```python\nprint("one")\nprint("two")\nprint("three")\nprint("four")\n```' };
    },
  };
  const messages = [{ role: 'user', content: 'write a python script that prints four lines' }];
  await runAgent({ provider, model: 'qwen2.5-coder:7b', workspace: ws, messages, mode: 'yolo', contextBudget: 8192 });
  messages.push({ role: 'user', content: 'thanks! now make a python file that says bye' });
  await runAgent({ provider, model: 'qwen2.5-coder:7b', workspace: ws, messages, mode: 'yolo', contextBudget: 8192 });
  assert.equal(systems[0], systems[1]);
  assert.match(lasts[0], /project is EMPTY/);
  assert.match(lasts[1], /main\.py/);
  assert.ok(!messages.some((m) => m.content.includes('[Project files right now]')), 'the note is never saved in the chat');
});
