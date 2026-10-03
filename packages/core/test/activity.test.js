import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent, buildSystemPrompt, thinksNatively, analyze } from '../src/index.js';
import { createNodeWorkspace } from '../src/node-workspace.js';

test('agent reports each step (context size, what it is reading) and the raw output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-act-'));
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello');
  const script = ['<think>I should read a.txt first.</think>\n<tool:read_file>\n<path>a.txt</path>\n</tool:read_file>', '<think>It says hello.</think>It says hello.'];
  let i = 0;
  const provider = { async *stream() { for (const c of script[i++].match(/[\s\S]{1,5}/g)) yield { type: 'text', text: c }; } };
  const events = [];
  const res = await runAgent({ provider, model: 'm', workspace: createNodeWorkspace(dir), messages: [{ role: 'user', content: 'what is in a.txt?' }], mode: 'auto', onEvent: (e) => events.push(e) });
  assert.equal(res.status, 'done');
  const steps = events.filter((e) => e.type === 'step');
  assert.equal(steps.length, 2);
  assert.ok(steps[0].promptTokens > 100);
  assert.equal(steps[0].after, null);
  assert.equal(steps[1].after, 'read_file');
  assert.ok(steps[1].promptTokens > steps[0].promptTokens);
  // raw = exactly what the model wrote, in order (step 1 before step 2)
  const raw = events.filter((e) => e.type === 'raw').map((e) => e.delta).join('');
  assert.equal(raw, script.join(''));
  const thoughts = events.filter((e) => e.type === 'thinking').map((e) => e.delta).join('');
  assert.match(thoughts, /I should read a\.txt first\.It says hello\./);
  // thoughts are not sent back to the model
  assert.ok(!res.messages.some((m) => m.role === 'assistant' && m.content.includes('<think>')));
});

test('think out loud prompt, and native thinkers are detected', () => {
  const ws = { name: 'x', capabilities: {} };
  assert.match(buildSystemPrompt({ workspace: ws, thinkAloud: true }), /Think out loud/);
  assert.doesNotMatch(buildSystemPrompt({ workspace: ws }), /Think out loud/);
  assert.match(buildSystemPrompt({ workspace: ws, lite: true, thinkAloud: true }), /<think>/);
  assert.ok(thinksNatively('qwen3:8b') && thinksNatively('Qwen3-0.6B-q4f16_1-MLC') && thinksNatively('gpt-oss:20b') && thinksNatively('deepseek-r1:7b'));
  assert.ok(!thinksNatively('qwen3-coder:30b') && !thinksNatively('qwen2.5-coder:7b') && !thinksNatively('llama3.2:3b'));
});

test('a tool call inside an unclosed <think> still runs', () => {
  const a = analyze('<think>I will write it now\n<tool:write_file>\n<path>a.html</path>\n<content>\n<p>x</p>\n</content>\n</tool:write_file>');
  assert.equal(a.call?.name, 'write_file');
  assert.equal(a.call.complete, true);
  assert.match(a.thinking, /I will write it now/);
});

test('detects garbled GPU output, not normal replies', async () => {
  const { looksGarbled } = await import('../src/index.js');
  const bad = '!type会会长/drivers.s statusCode开战 then runsistol :.0"\n```\n207070.4.subaday.then .\nlify suce .\nlifyNST. Ifさ价g8, y suce .\n18价\n``,01价 import the:\n1价ge-fly testament viewer.attributes软件 helf';
  assert.ok(looksGarbled(bad, 'Hello!'));
  assert.ok(!looksGarbled('Hello! 👋 How can I help with your project today? I can write code, fix bugs or explain things.', 'Hello!'));
  assert.ok(!looksGarbled('你好！我可以帮你写代码。请告诉我你想做什么项目，比如网站或者游戏。我们开始吧！', 'Hello!'), 'a full Chinese reply is a language mix-up, not broken math');
  assert.ok(!looksGarbled('这是一个计数器 app，点击按钮 +1。代码在 index.html 里面，打开就能用了。', '做一个计数器 app'));
  assert.ok(!looksGarbled('```html\n<!DOCTYPE html>\n<html><body><h1>Counter</h1><button id="add">+1</button></body></html>\n```', 'make a counter'));
});
