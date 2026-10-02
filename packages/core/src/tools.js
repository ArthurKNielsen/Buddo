// Tool definitions + executor. Tools use an XML-ish text protocol so they work
// with ANY local model (no native function-calling support required).

import { diffLines, diffStats } from './diff.js';
import { formatTree } from './tree.js';

export const TOOLS = [
  {
    name: 'list_dir',
    kind: 'read',
    params: ['path', 'depth'],
    desc: 'List files and folders as a tree. `depth` defaults to 2.',
    example: '<tool:list_dir>\n<path>src</path>\n</tool:list_dir>',
  },
  {
    name: 'read_file',
    kind: 'read',
    params: ['path', 'start', 'end'],
    desc: 'Read a file. Output has line numbers (do NOT copy them into edits). Optional `start`/`end` line numbers for big files.',
    example: '<tool:read_file>\n<path>src/app.js</path>\n</tool:read_file>',
  },
  {
    name: 'search',
    kind: 'read',
    params: ['pattern', 'path', 'glob'],
    desc: 'Search file contents with a regex (case-insensitive). Returns file:line: text. Optional `path` folder and `glob` filter like *.ts',
    example: '<tool:search>\n<pattern>function login</pattern>\n</tool:search>',
  },
  {
    name: 'glob',
    kind: 'read',
    params: ['pattern'],
    desc: 'Find files by name pattern, e.g. **/*.test.js or src/**/*.css',
    example: '<tool:glob>\n<pattern>**/*.py</pattern>\n</tool:glob>',
  },
  {
    name: 'write_file',
    kind: 'write',
    params: ['path', 'content'],
    desc: 'Create or fully overwrite a file with raw content (no escaping needed). Prefer edit_file for small changes to existing files.',
    example: '<tool:write_file>\n<path>hello.py</path>\n<content>\nprint("hi")\n</content>\n</tool:write_file>',
  },
  {
    name: 'edit_file',
    kind: 'write',
    params: ['path', 'old', 'new', 'all'],
    desc: 'Replace an exact snippet in a file. `old` must match the file exactly (copy it from read_file, without line numbers) and be unique; include surrounding lines if needed. Set <all>true</all> to replace every occurrence.',
    example: '<tool:edit_file>\n<path>src/app.js</path>\n<old>\nconst port = 3000;\n</old>\n<new>\nconst port = process.env.PORT || 3000;\n</new>\n</tool:edit_file>',
  },
  {
    name: 'run_command',
    kind: 'exec',
    params: ['command', 'cwd'],
    desc: 'Run a shell command in the workspace (tests, builds, git, installs). Non-interactive only; 2 min timeout.',
    example: '<tool:run_command>\n<command>npm test</command>\n</tool:run_command>',
  },
  {
    name: 'fetch_url',
    kind: 'read',
    params: ['url'],
    desc: 'Fetch a web page or docs URL and return its readable text.',
    example: '<tool:fetch_url>\n<url>https://example.com/docs</url>\n</tool:fetch_url>',
  },
  {
    name: 'todo',
    kind: 'meta',
    params: ['items'],
    desc: 'Track a plan for multi-step tasks. One item per line as "[ ] task", "[~] in progress" or "[x] done". Send the FULL list each time.',
    example: '<tool:todo>\n<items>\n[x] Read the router\n[~] Add /health endpoint\n[ ] Run tests\n</items>\n</tool:todo>',
  },
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
// Params whose value can be large free-form text (may contain tag-like text).
export const BIG_PARAMS = new Set(['content', 'old', 'new', 'items']);

const MAX_OUTPUT = 12000;

function clip(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.35));
  return `${head}\n\n… [${text.length - head.length - tail.length} chars omitted] …\n\n${tail}`;
}

export function parseTodos(items = '') {
  return items
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(?:[-*]\s*)?\[( |x|X|~|-|>)\]\s*(.*)$/.exec(l);
      if (!m) return { status: 'pending', text: l.replace(/^[-*]\s*/, '') };
      const s = m[1].toLowerCase();
      return { status: s === 'x' ? 'done' : s === ' ' ? 'pending' : 'active', text: m[2] };
    });
}

function normalizeWs(s) {
  return s.split('\n').map((l) => l.trim()).join('\n');
}

// Find `old` in `content`; falls back to whitespace-insensitive line matching.
export function locateSnippet(content, old) {
  const exact = [];
  let i = content.indexOf(old);
  while (i !== -1) {
    exact.push([i, i + old.length]);
    i = content.indexOf(old, i + Math.max(1, old.length));
  }
  if (exact.length) return exact;

  const lines = content.split('\n');
  const want = normalizeWs(old.replace(/^\n+|\n+$/g, '')).split('\n');
  if (!want.length || !want.join('').length) return [];
  const offsets = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  const found = [];
  for (let s = 0; s + want.length <= lines.length; s++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (lines[s + k].trim() !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const end = s + want.length - 1;
      found.push([offsets[s], offsets[end] + lines[end].length]);
    }
  }
  return found;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * Execute a parsed tool call against a workspace.
 * Returns { ok, output (string for the model), display (structured, for UIs) }.
 */
export async function executeTool(call, ctx) {
  const { workspace } = ctx;
  const a = call.args || {};
  const tool = TOOL_MAP[call.name];
  if (!tool) {
    return { ok: false, output: `Unknown tool "${call.name}". Available: ${TOOLS.map((t) => t.name).join(', ')}` };
  }
  const need = (k) => {
    if (a[k] === undefined || a[k] === '') throw new Error(`Missing <${k}> parameter for ${call.name}.`);
    return a[k];
  };

  try {
    switch (call.name) {
      case 'list_dir': {
        const depth = Math.min(parseInt(a.depth, 10) || 2, 6);
        const entries = await workspace.list(a.path || '.', depth);
        const tree = formatTree(entries, a.path || '.', 400);
        return { ok: true, output: tree || '(empty directory)', display: { type: 'tree', entries } };
      }
      case 'read_file': {
        const path = need('path');
        const content = await workspace.read(path);
        const lines = content.split('\n');
        const start = Math.max(1, parseInt(a.start, 10) || 1);
        const end = Math.min(lines.length, parseInt(a.end, 10) || start + 1499);
        const width = String(end).length;
        let out = lines
          .slice(start - 1, end)
          .map((l, idx) => `${String(start + idx).padStart(width)}\t${l}`)
          .join('\n');
        if (end < lines.length) out += `\n… (${lines.length - end} more lines — read again with <start>${end + 1}</start>)`;
        return {
          ok: true,
          output: clip(out, 40000),
          display: { type: 'file', path, content, start, end, total: lines.length },
        };
      }
      case 'search': {
        const pattern = need('pattern');
        const hits = await workspace.search(pattern, { path: a.path || '.', glob: a.glob, limit: 120 });
        if (!hits.length) return { ok: true, output: `No matches for /${pattern}/.`, display: { type: 'search', hits } };
        const out = hits.map((h) => `${h.file}:${h.line}: ${h.text.trim().slice(0, 220)}`).join('\n');
        return { ok: true, output: clip(out) + (hits.length >= 120 ? '\n(results capped at 120)' : ''), display: { type: 'search', hits } };
      }
      case 'glob': {
        const files = await workspace.glob(need('pattern'));
        return {
          ok: true,
          output: files.length ? clip(files.slice(0, 500).join('\n')) : 'No files matched.',
          display: { type: 'files', files },
        };
      }
      case 'write_file': {
        const path = need('path');
        const content = a.content ?? '';
        let before = null;
        try {
          before = await workspace.read(path);
        } catch {}
        await workspace.write(path, content);
        ctx.onChange?.({ path, before, after: content });
        const stats = diffStats(diffLines(before ?? '', content));
        return {
          ok: true,
          output: `${before === null ? 'Created' : 'Overwrote'} ${path} (${content.split('\n').length} lines, +${stats.added} -${stats.removed}).`,
          display: { type: 'diff', path, before, after: content, created: before === null },
        };
      }
      case 'edit_file': {
        const path = need('path');
        const old = need('old');
        const neu = a.new ?? '';
        const content = await workspace.read(path);
        const matches = locateSnippet(content, old);
        if (!matches.length) {
          return {
            ok: false,
            output: `Could not find the <old> snippet in ${path}. Read the file again and copy the exact text (without line numbers), or use write_file.`,
          };
        }
        const all = /^(true|yes|1)$/i.test((a.all || '').trim());
        if (matches.length > 1 && !all) {
          const where = matches.map(([s]) => lineOf(content, s)).join(', ');
          return {
            ok: false,
            output: `The <old> snippet appears ${matches.length} times in ${path} (lines ${where}). Include more surrounding lines to make it unique, or set <all>true</all>.`,
          };
        }
        let after = content;
        for (const [s, e] of [...matches].reverse()) after = after.slice(0, s) + neu + after.slice(e);
        await workspace.write(path, after);
        ctx.onChange?.({ path, before: content, after });
        const stats = diffStats(diffLines(content, after));
        return {
          ok: true,
          output: `Edited ${path} at line ${lineOf(content, matches[0][0])} (+${stats.added} -${stats.removed}).`,
          display: { type: 'diff', path, before: content, after },
        };
      }
      case 'run_command': {
        if (!workspace.capabilities?.exec) {
          return {
            ok: false,
            output: 'Shell commands are not available in this workspace (browser mode). Tell the user what to run instead, or ask them to use the Buddo desktop app / `buddo web`.',
          };
        }
        const command = need('command');
        const r = await workspace.run(command, { cwd: a.cwd, timeout: 120000, onData: ctx.onCommandData });
        const out = [r.stdout, r.stderr].filter(Boolean).join(r.stdout && r.stderr ? '\n' : '');
        ctx.onCommand?.({ command, output: out, code: r.code });
        return {
          ok: r.code === 0,
          output: `$ ${command}\n${clip(out || '(no output)')}\n[exit code ${r.code}${r.timedOut ? ', timed out' : ''}]`,
          display: { type: 'terminal', command, output: out, code: r.code },
        };
      }
      case 'fetch_url': {
        const url = need('url').trim();
        const text = await workspace.fetchUrl(url);
        return { ok: true, output: clip(text, 15000), display: { type: 'web', url, text } };
      }
      case 'todo': {
        const todos = parseTodos(a.items || '');
        ctx.onTodos?.(todos);
        const done = todos.filter((t) => t.status === 'done').length;
        return { ok: true, output: `Todo list updated (${done}/${todos.length} done).`, display: { type: 'todos', todos } };
      }
    }
  } catch (err) {
    return { ok: false, output: `Error: ${err?.message || err}` };
  }
  return { ok: false, output: 'Tool not implemented.' };
}

/** Short human label for a tool call (used in UIs). */
export function describeCall(call) {
  const a = call.args || {};
  switch (call.name) {
    case 'list_dir': return a.path || '.';
    case 'read_file': return a.path + (a.start ? `:${a.start}${a.end ? '-' + a.end : ''}` : '');
    case 'search': return `/${a.pattern}/` + (a.glob ? ` in ${a.glob}` : a.path && a.path !== '.' ? ` in ${a.path}` : '');
    case 'glob': return a.pattern;
    case 'write_file':
    case 'edit_file': return a.path;
    case 'run_command': return a.command;
    case 'fetch_url': return a.url;
    case 'todo': return `${parseTodos(a.items).length} items`;
    default: return '';
  }
}
