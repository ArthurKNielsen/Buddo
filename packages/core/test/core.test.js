import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyze, findToolCall, diffLines, diffStats, globToRegExp, locateSnippet, runAgent, parseSlash, parseTodos } from '../src/index.js';
import { createNodeWorkspace } from '../src/node-workspace.js';

test('parses tool calls with raw multi-line content', () => {
  const t = 'Let me write it.\n<tool:write_file>\n<path>a.js</path>\n<content>\nconst x = "<b>";\n</content>\n</tool:write_file>\nhallucinated';
  const c = findToolCall(t);
  assert.equal(c.name, 'write_file');
  assert.equal(c.complete, true);
  assert.deepEqual(c.args, { path: 'a.js', content: 'const x = "<b>";' });
});

test('strips code fences and thinking', () => {
  const a = analyze('<think>hmm</think>Ok\n```xml\n<tool:read_file>\n<path>x</path>\n</tool:read_file>\n```');
  assert.equal(a.thinking, 'hmm');
  assert.equal(a.prose.trim(), 'Ok');
  assert.equal(a.call.args.path, 'x');
  const partial = analyze('Hello <to');
  assert.equal(partial.safe, 'Hello ');
  assert.equal(analyze('Checking.\n<tool:run_command').safe, 'Checking.\n');
  assert.equal(analyze('a < b and c').safe, 'a < b and c');
});

test('accepts native JSON tool calls', () => {
  const c = analyze('ok <tool_call>\n{"name": "read_file", "arguments": {"path": "a.js", "start": 3}}\n</tool_call> extra').call;
  assert.equal(c.name, 'read_file');
  assert.deepEqual(c.args, { path: 'a.js', start: '3' });
});

test('diff + glob + snippet + todos', () => {
  const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(diffStats(d), { added: 2, removed: 1 });
  assert.ok(globToRegExp('**/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('*.{js,jsx}').test('deep/x.jsx'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.equal(locateSnippet('  foo()\n  bar()\n', 'foo()\nbar()').length, 1);
  assert.deepEqual(parseTodos('[x] a\n[~] b\n[ ] c').map((t) => t.status), ['done', 'active', 'pending']);
  assert.equal(parseSlash('/fix the login').cmd.name, 'fix');
});

test('agent loop end-to-end with a scripted model', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-'));
  await fs.writeFile(path.join(dir, 'app.js'), 'const port = 3000;\nconsole.log(port);\n');
  const ws = createNodeWorkspace(dir);
  const script = [
    'I will read it.\n<tool:read_file>\n<path>app.js</path>\n</tool:read_file>\n<tool_result>fake</tool_result>',
    '<tool:edit_file>\n<path>app.js</path>\n<old>\nconst port = 3000;\n</old>\n<new>\nconst port = process.env.PORT || 3000;\n</new>\n</tool:edit_file>',
    '<tool:run_command>\n<command>node app.js</command>\n</tool:run_command>',
    'Done! The port is now configurable.',
  ];
  let i = 0;
  const provider = {
    async *stream() {
      const text = script[i++];
      for (let k = 0; k < text.length; k += 7) yield { type: 'text', text: text.slice(k, k + 7) };
    },
  };
  const events = [];
  const messages = [{ role: 'user', content: 'make port configurable' }];
  const res = await runAgent({ provider, model: 'x', workspace: ws, messages, mode: 'auto', onEvent: (e) => events.push(e), askPermission: async () => 'allow' });
  assert.equal(res.status, 'done');
  assert.match(await fs.readFile(path.join(dir, 'app.js'), 'utf8'), /process\.env\.PORT/);
  const ends = events.filter((e) => e.type === 'tool-end');
  assert.equal(ends.length, 3);
  assert.ok(ends.every((e) => e.ok), JSON.stringify(ends.map((e) => e.output)));
  assert.match(ends[2].output, /3000/);
  assert.ok(!messages.some((m) => m.content.includes('fake')), 'hallucinated results are dropped');
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.ok(text.includes('I will read it.') && text.includes('Done!'));
  assert.ok(!text.includes('<tool'));
});

test('media tools: images reach vision models only', async () => {
  const ws = {
    name: 'w',
    capabilities: { exec: false },
    list: async () => [],
    read: async () => { throw new Error('nope'); },
    media: { view_image: async ({ path }) => ({ text: `IMAGE ${path}: cat`, images: ['QUJD'], display: { type: 'media', kind: 'image', objects: [] } }) },
  };
  for (const vision of [true, false]) {
    let i = 0;
    const seen = [];
    const provider = {
      async *stream({ messages }) {
        seen.push(messages);
        yield { type: 'text', text: i++ === 0 ? '<tool:view_image>\n<path>cat.png</path>\n</tool:view_image>' : 'A cat.' };
      },
    };
    const messages = [{ role: 'user', content: 'what is in cat.png?' }];
    const r = await runAgent({ provider, model: 'm', workspace: ws, messages, mode: 'auto', vision });
    assert.equal(r.status, 'done');
    const toolMsg = seen[1].find((m) => m.content.startsWith('<tool_result name="view_image"'));
    assert.ok(toolMsg.content.includes('IMAGE cat.png: cat'));
    assert.equal(!!toolMsg.images, vision);
    assert.ok(seen[0][0].content.includes(vision ? 'You can SEE images' : 'cannot see images'));
  }
});
