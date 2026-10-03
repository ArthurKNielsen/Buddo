import { sniffLang } from './edits.js';

// Small models often answer with plain markdown code blocks instead of tool calls.
// This turns those blocks into files: it finds (or infers) a filename for each block.

const EXT = {
  html: 'html', htm: 'html', xml: 'xml', svg: 'svg', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  js: 'js', javascript: 'js', jsx: 'jsx', mjs: 'js', ts: 'ts', typescript: 'ts', tsx: 'tsx', vue: 'vue', svelte: 'svelte',
  py: 'py', python: 'py', rb: 'rb', ruby: 'rb', go: 'go', golang: 'go', rs: 'rs', rust: 'rs', java: 'java', kt: 'kt', kotlin: 'kt',
  swift: 'swift', c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cs: 'cs', csharp: 'cs', php: 'php', lua: 'lua', dart: 'dart',
  json: 'json', yaml: 'yaml', yml: 'yml', toml: 'toml', sql: 'sql', md: 'md', markdown: 'md', r: 'r',
};

const DEFAULT_NAME = { html: 'index.html', css: 'styles.css', js: 'script.js', jsx: 'App.jsx', ts: 'index.ts', tsx: 'App.tsx', py: 'main.py', go: 'main.go', rs: 'main.rs', java: 'Main.java', c: 'main.c', cpp: 'main.cpp', cs: 'Program.cs', php: 'index.php', rb: 'main.rb', lua: 'main.lua', dart: 'main.dart', kt: 'Main.kt', swift: 'main.swift', vue: 'App.vue', svelte: 'App.svelte', scss: 'styles.scss', sql: 'schema.sql' };

// Never turn these into files (commands, output, data examples).
const SKIP_LANG = /^(bash|sh|shell|zsh|console|terminal|powershell|ps1?|cmd|bat|text|txt|output|log|plaintext|diff|patch)$/i;

const FILE_RE = /(?:^|[\s`*"'(:\[])((?:[\w-]+\/)*[\w.-]+\.(?:html?|css|s[ac]ss|less|m?jsx?|tsx?|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|lua|dart|json|ya?ml|toml|sql|md|xml|svg|txt|env|sh))(?=$|[\s`*"'):,\]])/i;

function nameFromFirstLine(code) {
  const first = code.split('\n', 1)[0].trim();
  const m = /^(?:\/\/|#|<!--|\/\*|--|;)\s*(?:file(?:name)?:\s*)?((?:[\w-]+\/)*[\w.-]+\.\w{1,6})\s*(?:-->|\*\/)?$/i.exec(first);
  return m ? m[1] : null;
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})[\w+#.:-]*\s*$/;

/**
 * Small models sometimes paste a whole HTML page WITHOUT a code fence (and may fence only bits of it,
 * like the <script>). Wrap such a page in one ```html block so it shows as code and can be saved.
 * `partial` also wraps a page that hasn't reached </html> yet (for streaming display).
 */
export function fenceRawHtml(text = '', { partial = false } = {}) {
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) return text;
  // Already inside a fenced block? (odd number of fence lines before it)
  const before = text.slice(0, start).split('\n').filter((l) => /^\s*(`{3,}|~{3,})/.test(l)).length;
  if (before % 2 === 1) return text;
  const close = text.toLowerCase().lastIndexOf('</html>');
  let end;
  if (close > start) end = close + 7;
  else if (partial || /<body/i.test(text.slice(start))) end = text.length;
  else return text;
  const page = text
    .slice(start, end)
    .split('\n')
    .filter((l) => !FENCE_LINE.test(l))
    .join('\n')
    .trim();
  const pre = text.slice(0, start).replace(/\s+$/, '');
  return `${pre}${pre ? '\n\n' : ''}\`\`\`html\n${page}\n\`\`\`\n${text.slice(end)}`;
}

/**
 * Find code blocks that should become files.
 * Returns [{ path, content, lang, inferred, truncated }].
 */
export function extractCodeFiles(text, { wantsCode = false } = {}) {
  text = fenceRawHtml(text);
  const out = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const fence = open[1];
    const info = `${open[2]} ${open[3]}`.trim();
    const body = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      if (lines[j].trim().startsWith(fence[0].repeat(fence.length)) && lines[j].trim().replace(/[`~]/g, '') === '') {
        closed = true;
        break;
      }
      body.push(lines[j]);
    }
    // Context: the closest non-empty line before the block (e.g. "**index.html**" or "Create `styles.css`:").
    let before = '';
    for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
      if (lines[k].trim()) {
        before = lines[k];
        break;
      }
    }
    let code = body.join('\n');
    const langWord = open[2].replace(/[:{].*$/, '').toLowerCase();
    let path = null;
    // ```html:index.html   ```index.html   ```js title="app.js"   ```python main.py
    path = /^[\w+#-]*:((?:[\w-]+\/)*[\w.-]+\.\w+)/.exec(open[2])?.[1] || (FILE_RE.test(` ${open[2]} `) && /\.\w+$/.test(open[2]) ? open[2] : null) || FILE_RE.exec(` ${open[3]} `)?.[1] || null;
    if (!path) {
      const fromLine = nameFromFirstLine(code);
      if (fromLine) path = fromLine;
    }
    if (!path && before) path = FILE_RE.exec(` ${before} `)?.[1] || null;
    const lang = EXT[langWord] || (path ? path.split('.').pop().toLowerCase() : '') || (EXT[langWord] === undefined ? EXT[sniffLang(code)] || '' : '');
    // "You can save this script in a file named hello.py" — a name right after the block counts
    // when its extension matches the block's language (so it isn't the next block's file).
    if (!path && lang) {
      for (let k = j + 1, seen = 0; k < lines.length && seen < 2; k++) {
        if (!lines[k].trim()) continue;
        if (/^\s*(`{3,}|~{3,})/.test(lines[k])) break;
        seen++;
        const name = FILE_RE.exec(` ${lines[k]} `)?.[1];
        if (name && EXT[name.split('.').pop().toLowerCase()] === lang) {
          path = name;
          break;
        }
      }
    }
    if (!code.trim() || SKIP_LANG.test(langWord)) {
      i = j + 1;
      continue;
    }
    out.push({ path, content: code.replace(/\s+$/, '') + '\n', lang, inferred: !path, truncated: !closed, info });
    i = j + 1;
  }

  // Name the unnamed blocks: use names the HTML links to (<link href="x.css">, <script src="y.js">), else defaults.
  const linked = {};
  for (const f of out.filter((x) => x.lang === 'html')) {
    for (const m of f.content.matchAll(/<link[^>]+href=["']([^"':]+\.css)["']/gi)) linked.css ??= m[1];
    for (const m of f.content.matchAll(/<script[^>]+src=["']([^"':]+\.m?js)["']/gi)) linked.js ??= m[1];
  }
  const used = new Set(out.filter((x) => x.path).map((x) => x.path));
  for (const f of out) {
    if (f.path) continue;
    let name = (f.lang === 'css' && linked.css) || (f.lang === 'js' && linked.js) || DEFAULT_NAME[f.lang];
    if (!name) continue;
    if (used.has(name)) {
      const [base, ext] = [name.replace(/\.[^.]+$/, ''), name.split('.').pop()];
      let n = 2;
      while (used.has(`${base}${n}.${ext}`)) n++;
      name = `${base}${n}.${ext}`;
    }
    f.path = name;
    used.add(name);
  }
  // A full HTML document is a file; small snippets without a name are usually examples.
  const worthSaving = (f) => {
    if (!f.path) return false;
    if (!f.inferred) return true;
    const lines = f.content.split('\n').length;
    return f.lang === 'html' ? /<html|<!doctype|<body/i.test(f.content) || lines >= 6 : lines >= 4;
  };
  let keep = out.filter(worthSaving);
  // The user asked for code and the model wrote one short unnamed block: that block IS the answer.
  if (!keep.length && wantsCode) {
    const best = out.filter((f) => f.path).sort((a, b) => b.content.length - a.content.length)[0];
    if (best) keep = [best];
  }
  return keep.map(({ info, ...f }) => ({ ...f, path: f.path.replace(/^\.?\//, '') }));
}

const BUILD_VERBS = /\b(build|make|create|write|code|generate|add|fix|change|update|edit|improve|redo|rewrite|style|design|implement|program|develop|put|turn|convert|refactor|clone|copy|recreate|move|remove|delete|replace|give|want|need)\b/i;
const CODE_NOUNS = /\b(website|web ?page|page|site|app|game|script|program|html|css|javascript|python|button|calculator|form|landing|todo|to-do|counter|timer|stopwatch|clock|quiz|portfolio)\b/i;
const QUESTION = /^\s*(what|why|how|explain|when|where|who|which|does|is|are)\b/i;
export const asksForCode = (text = '') => BUILD_VERBS.test(text) || (CODE_NOUNS.test(text) && !QUESTION.test(text));

const APOS = "(?:'|’)?";
const REFUSALS = [
  // "I can't create files", "I cannot write code to your computer", "I'm unable to save…"
  new RegExp(`\\bi\\s*(?:can${APOS}t|cannot|am not able to|am unable to|${APOS}m unable to|${APOS}m not able to)\\b[^.]{0,60}\\b(?:write|create|save|access|edit|modify|make|build|generate)\\b`, 'i'),
  // "I don't have the ability / access to …"
  new RegExp(`\\bi\\s*(?:do not|don${APOS}t) have (?:the )?(?:ability|access|capability)\\b`, 'i'),
  // "As an AI (language model) …"
  /\bas an ai\b/i,
];
export const isRefusal = (text = '') => REFUSALS.some((r) => r.test(text));
