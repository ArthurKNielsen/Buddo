import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDdgHtml, parseDdgLite, parseMojeek, webSearch, formatSearch, buildSystemPrompt, availableTools, estimateTokens,
  normalizeProfile, addMemory, personalityPrompt, runAgent, isTinyModel,
} from '../src/index.js';

test('parses DuckDuckGo HTML results (and unwraps redirect links, skips ads)', () => {
  const html = `
  <div class="result results_links results_links_deep result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Ad</a></div>
  <div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvite.dev%2Fguide%2Fmigration&amp;rut=abc">Migration from v6 | <b>Vite</b></a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Vite 7 now requires <b>Node.js</b> 20.19+ &amp; more.</a>
  </div></div>
  <div class="result results_links results_links_deep web-result "><h2><a rel="nofollow" class="result__a" href="https://example.com/b">Second &#x27;one&#x27;</a></h2></div>`;
  const r = parseDdgHtml(html);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { title: 'Migration from v6 | Vite', url: 'https://vite.dev/guide/migration', snippet: 'Vite 7 now requires Node.js 20.19+ & more.' });
  assert.equal(r[1].title, "Second 'one'");
});

test('parses DuckDuckGo Lite and Mojeek', () => {
  const lite = `<table><tr><td>1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&amp;rut=x" class='result-link'>Example Domain</a></td></tr>
    <tr><td></td><td class='result-snippet'>This domain is for use in <b>examples</b>.</td></tr>
    <tr><td>2.&nbsp;</td><td><a rel="nofollow" href="https://iana.org/" class='result-link'>IANA</a></td></tr></table>`;
  const l = parseDdgLite(lite);
  assert.equal(l.length, 2);
  assert.equal(l[0].url, 'https://example.com/');
  assert.equal(l[0].snippet, 'This domain is for use in examples.');
  const moj = `<ul class="results-standard"><li class="r1"><a class="ob" href="https://a.dev/">a.dev</a><h2><a class="title" href="https://a.dev/">A dev</a></h2><p class="s">Snippet <strong>one</strong></p></li><li class="r2"><h2><a class="title" href="https://b.dev/">B</a></h2><p class="s">two</p></li></ul>`;
  assert.deepEqual(parseMojeek(moj).map((x) => x.url), ['https://a.dev/', 'https://b.dev/']);
});

test('web search falls back across engines', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('duckduckgo')) return new Response('blocked', { status: 403 });
    if (String(url).includes('mojeek')) return new Response('<html>no results</html>');
    return new Response(JSON.stringify({ query: { search: [{ title: 'Ollama', snippet: 'An <span>LLM</span> runner' }] } }));
  };
  const r = await webSearch('ollama', { fetch: fakeFetch });
  assert.equal(r.engine, 'wikipedia');
  assert.equal(r.results[0].url, 'https://en.wikipedia.org/wiki/Ollama');
  assert.deepEqual(r.tried.map((t) => t.engine), ['duckduckgo', 'ddglite', 'mojeek']);
  assert.match(formatSearch('ollama', r), /1\. Ollama\n {3}https:\/\/en\.wikipedia\.org\/wiki\/Ollama/);
});

test('memory dedupes and personality reaches the prompt', () => {
  let p = normalizeProfile({ name: 'Bud', vibe: 'genz', about: { name: 'Arthur' } });
  p = addMemory(p, 'Prefers TypeScript over JavaScript');
  assert.ok(p);
  assert.equal(addMemory(p, 'prefers typescript over javascript!'), null, 'duplicate ignored');
  const prompt = personalityPrompt(p);
  assert.match(prompt, /Your name is Bud/);
  assert.match(prompt, /lowkey/);
  assert.match(prompt, /Name: Arthur/);
  assert.match(prompt, /- Prefers TypeScript over JavaScript/);
});

test('lite prompt is much shorter and keeps only essential tools', () => {
  const ws = { name: 'app', capabilities: { exec: true }, media: { screenshot() {} }, webSearch() {} };
  const full = buildSystemPrompt({ workspace: ws, profile: {} });
  const lite = buildSystemPrompt({ workspace: ws, profile: {}, lite: true });
  const ratio = estimateTokens(full) / estimateTokens(lite);
  // The full prompt got leaner too (no invented example files), so the gap is a bit smaller than it was.
  assert.ok(ratio > 3.5 && estimateTokens(lite) < 700, `full ${estimateTokens(full)} vs lite ${estimateTokens(lite)} tokens`);
  assert.deepEqual(availableTools(ws, { lite: true }).map((t) => t.name).sort(), ['edit_file', 'list_dir', 'read_file', 'remember', 'run_command', 'web_search', 'write_file']);
  assert.ok(full.includes('LOOK AT YOUR OWN WORK'));
  assert.ok(isTinyModel('qwen2.5-coder:0.5b') && isTinyModel('SmolLM2-360M-Instruct-q4f16_1-MLC') && !isTinyModel('qwen2.5-coder:7b'));
});

test('remember tool saves facts through the callback (and is hidden when learning is off)', async () => {
  const ws = { name: 'w', capabilities: { exec: false }, list: async () => [], read: async () => { throw new Error('x'); } };
  const saved = [];
  let i = 0;
  const provider = { async *stream() { yield { type: 'text', text: i++ === 0 ? '<tool:remember>\n<fact>Is 15 and learning React</fact>\n</tool:remember>' : 'Nice!' }; } };
  const r = await runAgent({ provider, model: 'm', workspace: ws, messages: [{ role: 'user', content: "I'm 15 and learning React" }], mode: 'auto', profile: {}, callbacks: { onRemember: (f) => (saved.push(f), true) } });
  assert.equal(r.status, 'done');
  assert.deepEqual(saved, ['Is 15 and learning React']);
  assert.ok(!buildSystemPrompt({ workspace: ws, profile: { learn: false } }).includes('### remember'));
});

test('streams code while the model is still writing it', async () => {
  const ws = { name: 'w', capabilities: { exec: false }, list: async () => [], read: async () => { throw new Error('nope'); }, write: async () => {} };
  const call = '<tool:write_file>\n<path>app.js</path>\n<content>\nconst a = 1;\nconst b = 2;\nconsole.log(a + b);\n</content>\n</tool:write_file>';
  let i = 0;
  const provider = {
    async *stream() {
      if (i++ > 0) return yield { type: 'text', text: 'Done.' };
      for (let k = 0; k < call.length; k += 5) yield { type: 'text', text: call.slice(k, k + 5) };
    },
  };
  const live = [];
  await runAgent({ provider, model: 'm', workspace: ws, messages: [{ role: 'user', content: 'go' }], mode: 'yolo', onEvent: (e) => e.type === 'tool-stream' && live.push(e) });
  const contents = live.filter((e) => e.args.content !== undefined).map((e) => e.args.content);
  assert.ok(contents.length > 5, 'many live updates');
  assert.ok(contents.every((c, k) => k === 0 || c.length >= contents[k - 1].length), 'content only grows');
  assert.ok(!contents.some((c) => c.includes('</')), 'half-written closing tags are hidden');
  assert.equal(contents.at(-1), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);');
  assert.equal(live.at(-1).args.path, 'app.js');
});
