// Tool definitions + executor. Tools use an XML-ish text protocol so they work
// with ANY local model (no native function-calling support required).

import { diffLines, diffStats } from './diff.js';
import { formatTree } from './tree.js';
import { formatSearch } from './websearch.js';

export const TOOLS = [
  {
    name: 'list_dir',
    kind: 'read',
    lite: true,
    params: ['path', 'depth'],
    desc: 'List files and folders as a tree. `depth` defaults to 2.',
    example: '<tool:list_dir>\n<path>src</path>\n</tool:list_dir>',
  },
  {
    name: 'read_file',
    kind: 'read',
    lite: true,
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
    lite: true,
    params: ['path', 'content'],
    desc: 'Create or fully overwrite a file with raw content (no escaping needed). Prefer edit_file for small changes to existing files.',
    example: '<tool:write_file>\n<path>hello.py</path>\n<content>\nprint("hi")\n</content>\n</tool:write_file>',
  },
  {
    name: 'edit_file',
    kind: 'write',
    lite: true,
    params: ['path', 'old', 'new', 'all'],
    desc: 'Replace an exact snippet in a file. `old` must match the file exactly (copy it from read_file, without line numbers) and be unique; include surrounding lines if needed. Set <all>true</all> to replace every occurrence.',
    example: '<tool:edit_file>\n<path>src/app.js</path>\n<old>\nconst port = 3000;\n</old>\n<new>\nconst port = process.env.PORT || 3000;\n</new>\n</tool:edit_file>',
  },
  {
    name: 'run_command',
    kind: 'exec',
    lite: true,
    params: ['command', 'cwd'],
    desc: 'Run a shell command in the workspace (tests, builds, git, installs). Non-interactive only; 2 min timeout.',
    example: '<tool:run_command>\n<command>npm test</command>\n</tool:run_command>',
  },
  {
    name: 'web_search',
    kind: 'read',
    lite: true,
    params: ['query', 'source'],
    desc: 'Search the internet (free). Use for docs, error messages, latest versions, news — anything you are not sure about. `source` is optional: web (default), npm (packages) or wikipedia. Then fetch_url the best result.',
    example: '<tool:web_search>\n<query>vite 7 migration guide</query>\n</tool:web_search>',
  },
  {
    name: 'fetch_url',
    kind: 'read',
    params: ['url'],
    desc: 'Fetch a web page or docs URL and return its readable text.',
    example: '<tool:fetch_url>\n<url>https://example.com/docs</url>\n</tool:fetch_url>',
  },
  {
    name: 'screenshot',
    kind: 'read',
    browser: true,
    params: ['target', 'size', 'full', 'actions'],
    desc: 'See your own work: open a web page and take a screenshot (attached so you can look at it) plus a report (console errors, broken images, horizontal overflow, visible text, buttons). `target`: a URL (e.g. http://localhost:5173) or an .html file in the project (default: index.html). `size`: desktop (default), mobile, or WIDTHxHEIGHT. `full`: true for the whole page. `actions`: optional steps, one per line — click <selector or text>, type <selector> <text>, press <key>, scroll <pixels>, hover <selector>, wait <ms>.',
    example: '<tool:screenshot>\n<target>index.html</target>\n<size>mobile</size>\n</tool:screenshot>',
  },
  {
    name: 'record_video',
    kind: 'read',
    browser: true,
    params: ['target', 'size', 'actions', 'seconds'],
    desc: 'Record a video of a web page while doing `actions` (same steps as screenshot) for animations, interactions and flows. Saves an .mp4 in .buddo/recordings/ and shows you the key frames. `seconds`: extra time to keep recording (default 4, max 30).',
    example: '<tool:record_video>\n<target>index.html</target>\n<actions>\nclick Add task\ntype #input Buy milk\npress Enter\n</actions>\n</tool:record_video>',
  },
  {
    name: 'make_video',
    kind: 'write',
    browser: true,
    params: ['target', 'size', 'seconds', 'fps', 'audio', 'out', 'transparent'],
    desc: 'Make a video out of UI elements: write an .html page (HTML/CSS/SVG/canvas, CSS animations, transitions, JS) first, then render it frame by frame into a video. Time is virtual, so every animation is smooth and exact. `size`: 1080p (default), 720p, vertical (1080×1920 for Shorts/Reels/TikTok), square or WIDTHxHEIGHT — design the page for that exact size (100vw × 100vh, no scrolling). `seconds`: length (default: until the last CSS animation ends; or set window.videoDuration = 8 in the page). For canvas or JS-driven scenes, define window.renderFrame = (t) => { …draw time t in seconds… }. `audio`: optional music/voice file from the project. `out`: .mp4 (default videos/NAME.mp4), .webm, .mov or .gif; `transparent`: true for a see-through .webm/.mov (page background must be transparent).',
    example: '<tool:make_video>\n<target>intro.html</target>\n<size>vertical</size>\n<seconds>6</seconds>\n<out>videos/intro.mp4</out>\n</tool:make_video>',
  },
  {
    name: 'edit_video',
    kind: 'write',
    media: true,
    params: ['input', 'steps', 'out'],
    desc: `Edit videos (and photos) with simple steps, one per line, applied in order. \`input\`: one or more files, one per line — several are joined in order (photos become 3s clips; change with "stills 4"). Steps (times are seconds or m:ss):
  trim 0:05-0:20 (keep only that part) · cut 0:03-0:04.5 (remove a part) · speed 2 (0.5 = slow motion)
  crop vertical|square|wide|WxH (fill + crop for Shorts/Reels) · fit vertical (whole frame on a blurred background) · rotate 90 · flip
  text "Hello!" top|center|bottom [0:01-0:03] [size 72] [color yellow] [box] · title "Big Title" [0:00-0:02] · captions (auto subtitles from speech)
  fade in 0.5 · fade out 1 · music song.mp3 [volume 0.3] [replace] · volume 1.5 · mute · color bw|vivid|warm|cool|bright|dark|vintage|cinematic
  logo logo.png [top-right] [size 15%] · overlay sticker.png [center] [0:02-0:05] · overlay lower-third.html [0:02-0:07] (an animated HTML/CSS UI element with a transparent background, rendered on top of the video)
\`out\`: .mp4 (default videos/NAME-edit.mp4), .webm, .mov or .gif. Never overwrites the input. Afterwards you see key frames of the result.`,
    example: '<tool:edit_video>\n<input>clip.mp4</input>\n<steps>\ntrim 0:02-0:32\ncrop vertical\ntext "Wait for it…" top 0:00-0:03\ncaptions\nmusic beat.mp3 volume 0.25\nfade out 1\n</steps>\n<out>videos/clip-short.mp4</out>\n</tool:edit_video>',
  },
  {
    name: 'watch_video',
    kind: 'read',
    media: true,
    params: ['path', 'start', 'end', 'frames'],
    desc: 'Watch a video file (mp4, mov, webm…). You get scene cuts, timestamped key frames (attached as ONE contact-sheet image, read left→right, top→bottom), objects in each frame, and what it sounds like (speech transcript with timestamps, sounds/music, loudness). Optional `start`/`end` (seconds or m:ss) to zoom into a part, `frames` (default 12, max 32) for more detail.',
    example: '<tool:watch_video>\n<path>clip.mp4</path>\n</tool:watch_video>',
  },
  {
    name: 'listen_audio',
    kind: 'read',
    media: true,
    params: ['path', 'start', 'end'],
    desc: 'Listen to an audio or video file (mp3, wav, m4a, mp4…): speech transcript with timestamps (any language), recognized sounds and music over time, loudness peaks and silences.',
    example: '<tool:listen_audio>\n<path>interview.mp3</path>\n</tool:listen_audio>',
  },
  {
    name: 'view_image',
    kind: 'read',
    media: true,
    params: ['path'],
    desc: 'Look at an image file (png, jpg, webp, gif…). The image is attached so you can see it, plus detected objects with their positions.',
    example: '<tool:view_image>\n<path>screenshot.png</path>\n</tool:view_image>',
  },
  {
    name: 'remember',
    kind: 'meta',
    lite: true,
    memory: true,
    params: ['fact'],
    desc: 'Save a lasting fact about the user so you know them better next time (their name, skills, preferences, tools they like, ongoing projects). One short sentence. Only for things that will still matter later — never secrets or passwords.',
    example: '<tool:remember>\n<fact>Prefers TypeScript and Tailwind for web projects</fact>\n</tool:remember>',
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
export const BIG_PARAMS = new Set(['content', 'old', 'new', 'items', 'steps']);

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

/** Widen [s, e) to its whole lines and their line break, when it covers nothing but whole lines. */
function wholeLines(content, s, e) {
  const ls = content.lastIndexOf('\n', s - 1) + 1;
  if (content.slice(ls, s).trim()) return [s, e];
  if (content[e - 1] === '\n') return [ls, e];
  const le = content.indexOf('\n', e);
  if (content.slice(e, le === -1 ? content.length : le).trim()) return [s, e];
  return le === -1 ? [Math.max(0, ls - 1), content.length] : [ls, le + 1];
}

// After UI changes, nudge the model to look at its own work.
function visualHint(path, workspace) {
  return workspace.media?.screenshot && /\.(html?|css|scss|jsx|tsx|vue|svelte|astro)$/i.test(path)
    ? ' Tip: when the UI is ready, check it with screenshot (and mobile size) before finishing.'
    : '';
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
          output: `${before === null ? 'Created' : 'Overwrote'} ${path} (${content.split('\n').length} lines, +${stats.added} -${stats.removed}).${visualHint(path, workspace)}`,
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
        for (const [s, e] of [...matches].reverse()) {
          // Deleting whole lines: take their line breaks too, so no blank line is left where they were.
          const [from, to] = neu.trim() ? [s, e] : wholeLines(content, s, e);
          after = after.slice(0, from) + (from === s && to === e ? neu : '') + after.slice(to);
        }
        await workspace.write(path, after);
        ctx.onChange?.({ path, before: content, after });
        const stats = diffStats(diffLines(content, after));
        return {
          ok: true,
          output: `Edited ${path} at line ${lineOf(content, matches[0][0])} (+${stats.added} -${stats.removed}).${visualHint(path, workspace)}`,
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
      case 'web_search': {
        const query = need('query');
        if (!workspace.webSearch) return { ok: false, output: 'Web search is not available here.' };
        const r = await workspace.webSearch(query, { source: (a.source || 'web').toLowerCase() });
        return { ok: r.results.length > 0, output: formatSearch(query, r), display: { type: 'websearch', query, engine: r.engine, results: r.results, tried: r.tried } };
      }
      case 'screenshot':
      case 'record_video': {
        if (!workspace.media?.[call.name]) {
          return { ok: false, output: 'Screenshots and recordings need the Buddo desktop app or `buddo web` with Chrome/Edge installed. Tell the user how to check the page instead.' };
        }
        const r = await workspace.media[call.name]({
          target: a.target || '',
          size: a.size || 'desktop',
          full: /^(true|yes|1)$/i.test(String(a.full || '').trim()),
          actions: a.actions || '',
          seconds: a.seconds ? Math.min(30, Math.max(0, parseFloat(a.seconds) || 4)) : undefined,
        });
        return { ok: true, output: r.text, images: r.images || [], display: r.display };
      }
      case 'make_video': {
        if (!workspace.media?.make_video) {
          return { ok: false, output: 'Making videos needs the Buddo desktop app or `buddo web` with Chrome/Edge installed. You can still write the HTML page; tell the user how to open it.' };
        }
        const r = await workspace.media.make_video({
          target: a.target || '',
          size: a.size || '1080p',
          seconds: a.seconds ? parseTime(a.seconds) : undefined,
          fps: a.fps ? parseInt(a.fps, 10) : undefined,
          audio: a.audio || undefined,
          out: a.out || undefined,
          transparent: /^(true|yes|1)$/i.test(String(a.transparent || '').trim()),
        });
        return { ok: true, output: r.text, images: r.images || [], display: r.display };
      }
      case 'edit_video': {
        if (!workspace.media?.edit_video) {
          return { ok: false, output: 'Editing videos needs the Buddo desktop app or `buddo web` (local mode). Tell the user.' };
        }
        const r = await workspace.media.edit_video({ inputs: need('input'), steps: a.steps || '', out: a.out || undefined });
        return { ok: true, output: r.text, images: r.images || [], display: r.display };
      }
      case 'remember': {
        const fact = need('fact').replace(/\s+/g, ' ').slice(0, 300);
        if (!ctx.onRemember) return { ok: false, output: 'Memory is turned off by the user.' };
        const saved = await ctx.onRemember(fact);
        return { ok: true, output: saved === false ? 'Already known.' : `Remembered: ${fact}`, display: { type: 'memory', fact } };
      }
      case 'fetch_url': {
        const url = need('url').trim();
        const text = await workspace.fetchUrl(url);
        return { ok: true, output: clip(text, 15000), display: { type: 'web', url, text } };
      }
      case 'watch_video':
      case 'listen_audio':
      case 'view_image': {
        if (!workspace.media) {
          return {
            ok: false,
            output: 'Watching videos, listening to audio and viewing image files needs the Buddo desktop app or `buddo web` (local mode). Tell the user, or ask them to attach the image in the chat.',
          };
        }
        const r = await workspace.media[call.name]({
          path: need('path'),
          start: parseTime(a.start),
          end: parseTime(a.end),
          frames: a.frames ? Math.min(32, Math.max(2, parseInt(a.frames, 10) || 12)) : undefined,
        });
        return { ok: true, output: r.text, images: r.images || [], display: r.display };
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

/** "1:23.5" | "83.5" | "83.5s" → seconds (undefined if empty). */
export function parseTime(v) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const parts = String(v).trim().replace(/s$/i, '').split(':').map(Number);
  if (parts.some((x) => Number.isNaN(x))) return undefined;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
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
    case 'web_search': return `“${a.query}”${a.source && a.source !== 'web' ? ` on ${a.source}` : ''}`;
    case 'screenshot':
    case 'record_video': return `${a.target || 'index.html'}${a.size && a.size !== 'desktop' ? ` · ${a.size}` : ''}`;
    case 'make_video': return `${a.target || 'index.html'} → ${a.out || 'video'}${a.size ? ` · ${a.size}` : ''}`;
    case 'edit_video': return `${String(a.input || '').split('\n').map((s) => s.trim()).filter(Boolean).join(' + ')}${a.out ? ` → ${a.out}` : ''}`;
    case 'remember': return a.fact;
    case 'watch_video':
    case 'listen_audio': return a.path + (a.start || a.end ? ` (${a.start || 0}–${a.end || 'end'})` : '');
    case 'view_image': return a.path;
    case 'todo': return `${parseTodos(a.items).length} items`;
    default: return '';
  }
}
