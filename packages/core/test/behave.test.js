import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent, buildSystemPrompt, ollamaProvider } from '../src/index.js';
import { findLoop, dropRepeats, sameAnswer, promisesAction, parseForcedCall, toolCallText } from '../src/behave.js';
import { analyze } from '../src/parser.js';
import { createNodeWorkspace } from '../src/node-workspace.js';

async function chat(prompt, reply, { history = [], supports = {}, caps = [], files = {}, model = 'qwen2.5-coder:7b', opts = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-behave-'));
  for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(dir, f), c);
  const ws = createNodeWorkspace(dir);
  const seen = [];
  let i = 0;
  const provider = {
    id: 'ollama',
    supports,
    modelInfo: async () => ({ capabilities: caps }),
    async *stream({ messages, options }) {
      seen.push({ messages, options });
      yield* reply({ messages, options, i: i++ });
    },
  };
  const events = [];
  const messages = [...history, { role: 'user', content: prompt }];
  const res = await runAgent({ provider, model, workspace: ws, messages, mode: 'yolo', onEvent: (e) => events.push(e), ...opts });
  const read = (f) => fs.readFile(path.join(dir, f), 'utf8').catch(() => null);
  return { res, events, seen, read, messages };
}

test('models with built-in tool calling get the tools as JSON and their calls run', async () => {
  const { read, seen } = await chat('make hello.py that prints hello', function* ({ i }) {
    if (i === 0) yield { type: 'tool_call', name: 'write_file', args: { path: 'hello.py', content: 'print("hello")\n' } };
    else yield { type: 'text', text: 'Created hello.py.' };
  }, { supports: { tools: true }, caps: ['completion', 'tools'] });
  assert.equal(await read('hello.py'), 'print("hello")\n');
  assert.equal(seen[0].options.tools.find((t) => t.function.name === 'write_file').function.parameters.required.join(), 'path,content');
  assert.doesNotMatch(seen[0].messages[0].content, /<tool:TOOL_NAME>/, 'no XML manual when the engine does tool calls');
  assert.equal(seen[0].messages[1].role, 'user', 'no text-protocol example either');
});

test('models without tool support keep the text protocol, with a worked example', async () => {
  const { seen } = await chat('hi there', function* () {
    yield { type: 'text', text: 'Hey! What are we building?' };
  }, { supports: { tools: true }, caps: ['completion'], model: 'codellama:7b' });
  assert.equal(seen[0].options.tools, undefined);
  assert.match(seen[0].messages[0].content, /<tool:TOOL_NAME>/);
  assert.match(seen[0].messages[2].content, /<tool:write_file>/);
});

test('a reply that only promises to act is forced into a tool call', async () => {
  const { read, seen, events } = await chat('make a python script that prints the date', function* ({ options }) {
    if (options.format) yield { type: 'text', text: JSON.stringify({ tool: 'write_file', args: { path: 'date.py', content: 'import datetime\nprint(datetime.date.today())\n' } }) };
    else if (seen0++ === 0) yield { type: 'text', text: "Sure! I'll create date.py for you now." };
    else yield { type: 'text', text: 'Created date.py.' };
  }, { supports: { format: true }, opts: { strictTools: false } });
  assert.match(await read('date.py'), /datetime/);
  assert.ok(seen.some((x) => x.options.format?.properties?.tool));
  assert.ok(events.some((e) => e.type === 'nudge' && /said it would/.test(e.text)));
});
let seen0 = 0;

test('a reply that loops is cut off where it starts repeating', async () => {
  const line = 'I will now carefully check every single file in the project.';
  const { messages, events } = await chat('check my project', function* () {
    yield { type: 'text', text: `Okay.\n${line}\n${line}\n${line}\n${line}\n` };
  });
  const last = messages[messages.length - 1].content;
  assert.equal(last.split(line).length - 1, 1);
  assert.ok(events.some((e) => e.type === 'text-replace'));
});

test('an answer it already gave is asked again once', async () => {
  const old = 'Python is a programming language that is easy to read and great for scripts, data science, automation and web backends.';
  const { messages, seen } = await chat('tell me something else about it', function* ({ i }) {
    yield { type: 'text', text: i === 0 ? old : 'It was named after Monty Python, not the snake.' };
  }, { history: [{ role: 'user', content: 'what is python' }, { role: 'assistant', content: old }] });
  assert.equal(seen.length, 2);
  assert.match(seen[1].messages[seen[1].messages.length - 1].content, /Don't repeat it/);
  assert.match(messages[messages.length - 1].content, /Monty/);
});

test('helpers: loops, repeats, promises, forced calls', () => {
  assert.equal(findLoop('a\n```\nx = 1\nx = 1\nx = 1\nx = 1\n```\n'), -1, 'code may repeat');
  assert.ok(findLoop('Let me think about this problem. Let me think about this problem. Let me think about this problem.') > 0);
  assert.equal(dropRepeats('Here is the plan for your app.\n\nStep one.\n\nHere is the plan for your app.'), 'Here is the plan for your app.\n\nStep one.');
  assert.ok(sameAnswer('The button is blue because styles.css sets background blue on it', 'The button is blue because styles.css sets the background blue on it.'));
  assert.ok(!sameAnswer('The button is blue because styles.css sets it', 'Python was named after Monty Python and not after the snake at all'));
  assert.ok(promisesAction("Got it. I'll update styles.css now."));
  assert.ok(!promisesAction('I updated styles.css.'));
  assert.deepEqual(parseForcedCall('{"tool":"read_file","args":{"path":"a.py"}}', ['read_file']), { name: 'read_file', args: { path: 'a.py' } });
  assert.equal(parseForcedCall('{"tool":"nope","args":{}}', ['read_file']), null);
  const c = analyze(`Fixing it.\n\n${toolCallText('edit_file', { path: 'a.js', old: 'let x = 1;\n', new: 'let x = 2;\n' })}`).call;
  assert.equal(c.name, 'edit_file');
  assert.equal(c.args.old, 'let x = 1;\n');
});

test('the prompt says never lie and never repeat; native prompt is shorter', () => {
  const ws = { name: 'x', write: true, capabilities: { exec: true } };
  const full = buildSystemPrompt({ workspace: ws, files: [] });
  const native = buildSystemPrompt({ workspace: ws, files: [], nativeTools: true });
  assert.match(full, /Never lie/);
  assert.match(full, /Never repeat yourself/);
  assert.ok(native.length < full.length * 0.8);
});

test('the Ollama provider sends tools and reads tool calls back', async () => {
  let body;
  const fetch = async (url, o) => {
    body = JSON.parse(o.body);
    const lines = [
      { message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.py', start: 3 } } }] } },
      { done: true, done_reason: 'stop', message: { content: '' } },
    ];
    return new Response(lines.map((l) => JSON.stringify(l)).join('\n'));
  };
  const p = ollamaProvider({ fetch });
  const out = [];
  for await (const c of p.stream({ model: 'm', messages: [], options: { tools: [{ type: 'function' }] } })) out.push(c);
  assert.equal(body.tools.length, 1);
  assert.deepEqual(out[0], { type: 'tool_call', name: 'read_file', args: { path: 'a.py', start: '3' } });
});

const json = (o) => ({ type: 'text', text: JSON.stringify(o) });

test('strict replies: a build request cannot finish before a file is written', async () => {
  const { read, seen, events } = await chat('make a python script that prints the date', function* ({ options, i }) {
    const choices = options.format.properties.tool.enum;
    if (i === 0) {
      assert.ok(!choices.includes('done'), 'done is not an option yet');
      // Streams in pieces, like a real engine.
      const text = JSON.stringify({ say: 'Writing date.py.', tool: 'write_file', args: { path: 'date.py', content: 'import datetime\nprint(datetime.date.today())\n' } });
      for (let k = 0; k < text.length; k += 7) yield { type: 'text', text: text.slice(k, k + 7) };
    } else {
      assert.ok(choices.includes('done'));
      yield json({ say: 'Created date.py: run it with python date.py.', tool: 'done', args: {} });
    }
  }, { supports: { format: true } });
  assert.equal(await read('date.py'), 'import datetime\nprint(datetime.date.today())\n');
  assert.equal(seen.length, 2);
  assert.ok(events.some((e) => e.type === 'tool-stream' && e.args.content?.includes('datetime')), 'code shows while it is written');
  const said = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.match(said, /Writing date\.py\.[\s\S]*Created date\.py/);
  assert.doesNotMatch(said, /"tool"|\{/, 'the user never sees the JSON');
  assert.match(seen[0].messages[0].content, /Every reply is ONE JSON object/);
});

test('strict replies: a plain question can be answered right away', async () => {
  const { seen, messages } = await chat('what is a list comprehension', function* ({ options }) {
    assert.ok(options.format.properties.tool.enum.includes('done'));
    yield json({ say: 'A short way to build a list: [x * 2 for x in nums].', tool: 'done', args: {} });
  }, { supports: { format: true } });
  assert.equal(seen.length, 1);
  assert.match(messages[messages.length - 1].content, /short way/);
});

test('strict replies: every file the request names gets written before it can finish', async () => {
  const files = ['index.html', 'styles.css', 'script.js'];
  const enums = [];
  const { read, seen } = await chat('Build a landing page. Make 3 files: index.html, styles.css, script.js (linked together).', function* ({ options, i }) {
    enums.push(options.format.properties.tool.enum.includes('done'));
    if (i < 3) yield json({ say: '', tool: 'write_file', args: { path: files[i], content: `/* ${files[i]} */\nfile ${i}\n` } });
    else yield json({ say: 'Built the page in index.html, styles.css and script.js.', tool: 'done', args: {} });
  }, { supports: { format: true } });
  for (const f of files) assert.match(await read(f), new RegExp(f.replace('.', '\\.')));
  assert.deepEqual(enums, [false, false, false, true], '"done" only after all three files');
  assert.equal(seen.length, 4);
});
