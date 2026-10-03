// The agent loop: stream model output → detect a tool call → (ask permission) →
// execute → feed the result back → repeat until the model answers without tools.

import { analyze, splitThinking } from './parser.js';
import { executeTool, TOOL_MAP } from './tools.js';
import { buildSystemPrompt } from './prompt.js';
import { formatTree } from './tree.js';
import { LEARN_PROMPT, parseLearned, normalizeProfile } from './personality.js';
import { missingColors } from './colors.js';
import { quickChange } from './quick.js';
import { extractCodeFiles, asksForCode, isRefusal, fenceRawHtml, linkAssets } from './codeblocks.js';
import { planCodeSave, looksLikeEdit, isNewBuild, parseFindReplace, linkedFiles, asksToRemove, rewriteAsEdits, removalKind, keepOnlyRemovals, hasPlaceholders } from './edits.js';

export const estimateTokens = (s) => Math.ceil((s || '').length / 3.6);

// "I removed the title", "The button has been updated", "Done!": the reply says the change is made.
const CLAIMS_DONE = /\b(?:i(?:'ve|’ve| have)?|has been|have been|is now|are now)\s+(?:now\s+)?(?:removed|deleted|changed|updated|made|added|replaced|edited|fixed|modified|cleaned|moved|renamed|turned|styled)\b|^\s*(?:all )?done\b/im;

// The example page in the lite prompt (<h1>Hello</h1>), sent back instead of what was asked (seen on a phone:
// "add a green button" → a page that says Hello).
const copiedExample = (code = '') =>
  code.replace(/<!doctype[^>]*>|<\/?(?:html|head|body)\b[^>]*>|<meta\b[^>]*>|<title>[\s\S]*?<\/title>|\s+/gi, '').toLowerCase() === '<h1>hello</h1>';

// Vision models spend roughly this many tokens per attached image.
const IMAGE_TOKENS = 1000;

export function contextTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + (m.images?.length || 0) * IMAGE_TOKENS + 4, 0);
}

/** Keep images only on the most recent image-bearing messages (they are expensive). */
function trimImages(messages, keep = 2) {
  let seen = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    if (!out[i].images?.length) continue;
    if (++seen > keep) out[i] = { ...out[i], images: undefined, content: out[i].content + '\n[older image removed to save context]' };
  }
  return out;
}

/**
 * Old copies of files Buddo pasted in for small models ("[Current index.html]" + the code) and code the model
 * wrote that was already saved into files: only the newest copy matters, and on a tiny model with room for
 * ~4,000 tokens the old ones crowd out the actual conversation.
 */
export function slimHistory(messages) {
  const shown = (m) => m.role === 'user' && /\[Current [^\]\n]+\]\n`{3,}/.test(m.content);
  let newest = -1;
  for (let i = messages.length - 1; i >= 0 && newest < 0; i--) if (shown(messages[i])) newest = i;
  return messages.map((m, i) => {
    if (i !== newest && shown(m)) return { ...m, content: m.content.replace(/\[Current ([^\]\n]+)\]\n(`{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, '[an older copy of $1 was shown here]') };
    if (m.role === 'assistant' && i < messages.length - 1 && m.content.includes('[Buddo saved these code blocks as files:')) {
      return { ...m, content: m.content.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '```\n[this code was saved into the files]\n```') };
    }
    return m;
  });
}

/** In plain words, the tool result the model is about to read ("styles.css, 84 lines"). */
function describeResult(name, args = {}, content = '') {
  const body = content.replace(/^<tool_result[^>]*>\n?|\n?<\/tool_result>$/g, '');
  const lines = body.split('\n').length;
  const path = args?.path ? String(args.path).trim() : '';
  if (name === 'read_file') return `${path || 'a file'}, ${lines} lines`;
  if (name === 'search') return /^No matches/.test(body) ? `search for ${args?.pattern ?? ''}: no matches` : `search for ${args?.pattern ?? ''}: ${lines} matches`;
  if (name === 'list_dir' || name === 'glob') return `file list, ${lines} entries`;
  if (name === 'run_command') return `output of ${String(args?.command ?? 'a command').slice(0, 40)}`;
  if (name === 'write_file' || name === 'edit_file') return `result of saving ${path}`;
  return `${name} result`;
}

/** Shrink old tool results when the conversation gets close to the context budget. */
export function compactForModel(messages, budget) {
  messages = trimImages(messages);
  const total = contextTokens(messages);
  if (total < budget * 0.7) return messages;
  const keepTail = 6;
  return messages.map((m, i) => {
    if (i >= messages.length - keepTail) return m;
    if (m.role === 'user' && m.content.startsWith('<tool_result') && m.content.length > 600) {
      return { ...m, content: m.content.slice(0, 450) + '\n… [older tool output truncated to save context]\n</tool_result>' };
    }
    if (m.role === 'assistant' && m.content.length > 2500) {
      return { ...m, content: m.content.slice(0, 1200) + '\n… [truncated] …\n' + m.content.slice(-800) };
    }
    return m;
  });
}

/** Gather project context (file tree + BUDDO.md) for the system prompt. */
export async function gatherContext(workspace) {
  let tree = '';
  let memory = '';
  let names = null;
  try {
    const entries = await workspace.list('.', 2);
    tree = formatTree(entries, '.', 150);
    names = new Set(entries.map((e) => e.path));
  } catch {}
  for (const f of ['BUDDO.md', 'buddo.md', 'CLAUDE.md', 'AGENTS.md']) {
    if (names && !names.has(f)) continue;
    try {
      memory = (await workspace.read(f)).slice(0, 6000);
      if (memory) break;
    } catch {}
  }
  return { tree, memory };
}

function linkSignal(parent) {
  const ctrl = new AbortController();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl;
}

const NEEDS_PERMISSION = {
  ask: new Set(['write', 'exec']),
  auto: new Set(['exec']),
  yolo: new Set(),
  plan: new Set(),
};

/**
 * Run the agent.
 * @param {object} o
 * @param {object} o.provider     model provider with stream()
 * @param {string} o.model
 * @param {object} o.workspace
 * @param {Array}  o.messages     conversation history [{role, content}] (mutated: new turns are appended)
 * @param {string} o.mode         ask | auto | yolo | plan
 * @param {Function} o.onEvent    receives UI events
 * @param {Function} o.askPermission async (call) => 'allow' | 'deny' | 'always'
 */
export async function runAgent({
  provider,
  model,
  workspace,
  messages,
  mode = 'ask',
  onEvent = () => {},
  askPermission = async () => 'allow',
  signal,
  maxSteps = 50,
  contextBudget = 16384,
  temperature = 0.2,
  context,
  callbacks = {},
  vision = false,
  profile,
  lite = false,
  autoSaveCode = true,
  thinkAloud = false,
  quickEdits = true,
}) {
  const ctx = context || (await gatherContext(workspace));
  const system = buildSystemPrompt({ workspace, mode, vision, profile, lite, thinkAloud, ...ctx });
  const alwaysAllowed = new Set();
  let wroteFiles = false;
  let nudges = 0;
  const MAX_NUDGES = 2;
  let emptyRetries = 0;
  let freshNext = false;
  const lastUserMsg = () => [...messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith('<tool_result'));
  const lastUserText = () => lastUserMsg()?.content || '';
  // What the user typed, without the file Buddo attached for small models. Read once, before Buddo adds its
  // own nudges ("I couldn't tell which lines to delete…"), so those are never mistaken for the request.
  const asked = lastUserText().split('\n\n[Current ')[0];
  const askedText = () => asked;

  /** The page this conversation is working on: the last HTML file written here, else the project's index.html. */
  const findTarget = async () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const c = messages[i].content || '';
      const saved = /\[Buddo saved these code blocks as files: ([^\]]+)\]/.exec(c)?.[1]?.split(',').map((x) => x.trim().replace(/ \(.*\)$/, '')) || [];
      const written = [...c.matchAll(/<tool:write_file>\s*<path>([^<]+)<\/path>/g)].map((m) => m[1].trim());
      const html = [...saved, ...written].reverse().find((n) => /\.html?$/i.test(n));
      if (html) return html;
    }
    const all = await workspace.glob?.('**/*.html').catch(() => []);
    if (all?.includes('index.html')) return 'index.html';
    return all?.length === 1 ? all[0] : null;
  };
  const readTarget = async () => {
    const path = await findTarget();
    const content = path ? await workspace.read(path).catch(() => null) : null;
    return content === null ? null : { path, content };
  };
  /** The page plus the stylesheets and scripts it links: the files an edit to "the site" may touch. */
  const readEditFiles = async () => {
    const t = await readTarget();
    if (!t) return [];
    const dir = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/') + 1) : '';
    const out = [t];
    for (const rel of linkedFiles(t.content)) {
      const p = (dir + rel).replace(/^\.\//, '');
      const content = await workspace.read(p).catch(() => null);
      if (content !== null) out.push({ path: p, content });
    }
    return out;
  };
  const fence = (path, content) => `\`\`\`${path.split('.').pop()}\n${content.replace(/\n$/, '')}\n\`\`\``;
  // How to answer an edit. Spelled out line by line: tiny models copy the shape they see, so a one-line
  // description ("a <<<<<<< SEARCH / ======= / >>>>>>> REPLACE block") came back word for word, with no code.
  const editHow = (path) =>
    `Reply with only the change, each marker on its own line. Example (changes <p>Old text</p> to <p>New text</p>):\n\n${path}\n<<<<<<< SEARCH\n<p>Old text</p>\n=======\n<p>New text</p>\n>>>>>>> REPLACE\n\nCopy the SEARCH lines exactly from ${path}. Don't rewrite the whole file.`;

  // Tiny models (0.5B) copy the find/replace example instead of using it, so it's never asked for on
  // small files; a find/replace a model sends anyway is still applied.
  const SMALL_FILE = 2000;
  // Edits ask for just the changed lines: tiny models answer that naturally, and Buddo finds where they go
  // (mergeChangedLines). If it can't tell, it asks for the whole file.
  const askEdit = (paths) =>
    `Change only what was asked. Reply with ONLY the lines you change, written the new way: the file name on its own line, then a code block with just those lines. Don't rewrite whole files${paths.length > 1 ? ` (the project has ${paths.join(', ')})` : ''}. To add something new, also include the line just above where it goes.`;
  // Removals: "remove X" → just the lines that go; "remove everything except X" → the file with only what
  // stays (the shorter answer each time). Either way Buddo only deletes lines and keeps the rest as it is.
  const askRemove = (kind, paths) =>
    kind === 'keep'
      ? `Remove everything else and keep what was asked exactly as it is. Reply with the file name on its own line, then that whole file as it should end up in one code block: only the lines that stay, copied exactly. Don't change or add anything${paths.length > 1 ? ` (the project has ${paths.join(', ')})` : ''}.`
      : `Remove only what was asked and keep everything else as it is. Reply with the file name on its own line, then a code block with ONLY the lines to delete, copied exactly from the file, each starting with "- ". Don't rewrite the file${paths.length > 1 ? ` (the project has ${paths.join(', ')})` : ''}.`;
  const askChange = (paths) => (removal() ? askRemove(removal(), paths) : askEdit(paths));
  const showFiles = (fs) => fs.map((f) => `[Current ${f.path}]\n${fence(f.path, f.content)}`).join('\n');
  /** The files for an edit, small enough to show a small model (the page first). */
  const editFilesToShow = async (budget = 9000) => {
    const out = [];
    let used = 0;
    for (const f of await readEditFiles()) {
      if (used + f.content.length > budget) continue;
      out.push(f);
      used += f.content.length;
    }
    return out;
  };
  // Files written in this run (a new build) can be rewritten freely; files that were already there get edits.
  const createdHere = new Set();
  const rewriteWarned = new Set();
  const editRequest = () => !isNewBuild(askedText()) && !asksToRemove(askedText()) && looksLikeEdit(askedText());
  // The user only asked to take things out: 'remove' (named what goes) or 'keep' (named what stays).
  const removal = () => (mode === 'plan' ? null : removalKind(askedText()));

  /** Ask permission if needed, then run the tool. Returns the result, or null if the user stopped. */
  const perform = async (call, tool) => {
    if (tool && mode === 'plan' && (tool.kind === 'write' || tool.kind === 'exec')) {
      return { ok: false, output: 'Blocked: plan mode is read-only. Finish investigating and present your plan instead.' };
    }
    // Only asked to remove things, but the model rewrote a whole file: save just the lines it left out, and keep
    // every other line as it was (decided before asking, so the approval shows what will really change).
    let pruned = false;
    if (call.name === 'write_file' && !call.auto && removal()) {
      const path = String(call.args?.path || '').trim();
      const before = path && !createdHere.has(path) ? await workspace.read(path).catch(() => null) : null;
      if (before?.trim()) {
        const content = call.args.content ?? '';
        const kept = hasPlaceholders(content) ? null : keepOnlyRemovals(before, content);
        if (kept === null) {
          return {
            ok: false,
            output: `Nothing was removed: ${hasPlaceholders(content) ? `that rewrite of ${path} leaves parts out with "..." comments` : `that rewrite of ${path} still has every line`}. Delete only the lines that should go with edit_file (<old> = those lines copied exactly from the file, <new> left empty), one call per spot.`,
          };
        }
        pruned = kept !== content;
        call.args.content = kept;
      }
    }
    if (tool && NEEDS_PERMISSION[mode]?.has(tool.kind) && !alwaysAllowed.has(call.name)) {
      onEvent({ type: 'permission', call });
      const answer = await askPermission(call);
      if (signal?.aborted) return null;
      if (answer === 'always') alwaysAllowed.add(call.name);
      if (answer === 'deny') return { ok: false, output: 'The user denied this action. Ask what they would like instead, or try a different approach.', denied: true };
    }
    // Changing an existing file: ask once for just the lines that change instead of a whole new file.
    if (call.name === 'write_file' && !call.auto && editRequest()) {
      const path = String(call.args?.path || '').trim();
      const before = path && !createdHere.has(path) ? await workspace.read(path).catch(() => null) : null;
      if (before !== null && before.trim() && !rewriteWarned.has(path) && rewriteAsEdits(before, call.args.content ?? '')?.length !== 0) {
        rewriteWarned.add(path);
        return {
          ok: false,
          output: `${path} already exists, so don't rewrite all of it. Change only the lines that need to change with edit_file (one call per spot; copy <old> exactly from the file). If the whole file really must be replaced, call write_file again.`,
        };
      }
    }
    const result = await executeTool(call, {
      workspace,
      onChange: callbacks.onChange,
      onTodos: callbacks.onTodos,
      onRemember: normalizeProfile(profile).learn ? callbacks.onRemember : undefined,
      onCommand: callbacks.onCommand,
      onCommandData: callbacks.onCommandData,
    });
    if (pruned && result.ok) result.output += ' Only the removed lines were saved: the user asked to remove things, so every other line was kept exactly as it was.';
    if (result.ok && (call.name === 'write_file' || call.name === 'edit_file')) wroteFiles = true;
    if (result.ok && call.name === 'write_file' && result.display?.created) createdHere.add(String(call.args.path).trim());
    return result;
  };
  /** Save a change Buddo worked out itself as line edits (or a new file), and say what was done. */
  const applyQuick = async ({ changes, summary }) => {
    const saved = [];
    for (const c of changes) {
      const edits = c.before == null ? null : rewriteAsEdits(c.before, c.after);
      const calls = edits?.length
        ? edits.map((e) => ({ name: 'edit_file', args: { path: c.path, old: e.old, new: e.new } }))
        : [{ name: 'write_file', args: { path: c.path, content: c.after } }];
      for (const x of calls) {
        const call = { id: `t${Date.now().toString(36)}${id++}`, ...x, auto: true, quick: true };
        onEvent({ type: 'tool-start', call, kind: 'write', auto: true });
        const result = await perform(call, TOOL_MAP[call.name]);
        if (!result) {
          onEvent({ type: 'tool-end', id: call.id, ok: false, output: 'Stopped.' });
          onEvent({ type: 'stopped' });
          return { messages, status: 'stopped' };
        }
        onEvent({ type: 'tool-end', id: call.id, ok: result.ok, output: result.output, display: result.display, denied: result.denied });
        if (result.denied) {
          const text = 'Okay, I left it as it was.';
          onEvent({ type: 'text', delta: text });
          messages.push({ role: 'assistant', content: text });
          onEvent({ type: 'done' });
          return { messages, status: 'done' };
        }
        if (!result.ok) return saved.length ? nothingSaved(result.output, '') : null; // let the model try instead
      }
      saved.push(c.before == null ? c.path : `${c.path} (edited)`);
    }
    const text = `Done: ${summary} Buddo did this one itself, so only what you asked for changed.`;
    onEvent({ type: 'text', delta: text });
    messages.push({ role: 'assistant', content: `${text}\n\n[Buddo saved these code blocks as files: ${saved.join(', ')}]` });
    onEvent({ type: 'done' });
    return { messages, status: 'done' };
  };
  /** Is the reply (partly) the system prompt read back, like "# Personality · Your name is Buddo…"? */
  const repeatsInstructions = (text) => {
    const hits = text.split('\n').map((l) => l.replace(/^[\s>*#-]+/, '').trim()).filter((l) => l.length >= 40 && system.includes(l));
    return hits.length >= 2 || hits.some((l) => l.length >= 80);
  };
  /** End a turn that changed nothing, saying so plainly (and telling the model, for the next turn). */
  const nothingSaved = (why, text) => {
    const said = CLAIMS_DONE.test(text) ? ' The reply says the change was made, but it was not.' : '';
    messages[messages.length - 1].content += `\n\n[Buddo: nothing was saved, the files are unchanged (${why}).]`;
    onEvent({ type: 'error', error: `Nothing was changed: ${why}.${said} Your files are as they were — try asking again, or pick a bigger model.` });
    return { messages, status: 'error' };
  };
  let lastCallArgs = null;
  let lastSig = '';
  let repeats = 0;
  let incomplete = 0;
  let id = 0;

  // Simple requests ("add a green button", "make the button blue", "remove the heading"): Buddo does them itself,
  // exactly, so no model can overdo them, miss them or rewrite the file. Everything else goes to the model.
  if (quickEdits && autoSaveCode && mode !== 'plan' && workspace.write) {
    const msg = lastUserMsg();
    if (msg && msg === messages[messages.length - 1]) {
      // Without the files an @mention attached; a mentioned page is the one to change.
      const request = asked.split(/\n\n(?:<file path=|\()/)[0].replace(/(^|\s)@[\w./-]+/g, ' ').trim();
      const mentioned = /(?:^|\s)@([\w./-]+\.html?)\b/i.exec(asked)?.[1];
      const all = mentioned ? [{ path: mentioned, content: await workspace.read(mentioned).catch(() => null) }].filter((f) => f.content !== null) : await readEditFiles();
      const [page = null, ...files] = all;
      const empty = !page && !(await workspace.list('.', 1).catch(() => [null])).length;
      const quick = quickChange(request, { page, files, empty });
      if (quick) {
        const result = await applyQuick(quick);
        if (result) return result;
      }
    }
  }

  // Small models can't open files themselves: for an edit request, show them the current page.
  if (lite && autoSaveCode && mode !== 'plan' && workspace.write) {
    const msg = lastUserMsg();
    if (msg && msg === messages[messages.length - 1] && (looksLikeEdit(msg.content) || removalKind(msg.content)) && !msg.content.includes('<file path=')) {
      const shown = await editFilesToShow();
      if (shown.length && shown[0].content.length < 7000) {
        msg.content += `\n\n${showFiles(shown)}\n${askChange(shown.map((f) => f.path))}`;
        onEvent({ type: 'nudge', text: `Showed the model the current ${shown.map((f) => f.path).join(', ')} to edit` });
      }
    }
  }


  for (let step = 0; step < maxSteps; step++) {
    const ctrl = linkSignal(signal);
    let raw = '';
    let sentProse = 0;
    let sentThink = 0;
    let nativeThinking = '';
    let usage = null;
    let finish = null;
    let stopForTool = false;
    let announced = false;
    let streamedSize = -1;

    const wire = [{ role: 'system', content: system }, ...compactForModel(slimHistory(messages), contextBudget)].map((m) =>
      vision || !m.images ? m : { role: m.role, content: m.content },
    );
    // Tell UIs what the model is reading right now (before the first token, it is "reading the prompt").
    const prev = messages[messages.length - 1];
    const after = prev?.role === 'user' && prev.content.startsWith('<tool_result') ? /name="([^"]+)"/.exec(prev.content)?.[1] : null;
    // …and what that is made of: Buddo's instructions, the chat so far, and the newest thing (your message or a tool result).
    const total = contextTokens(wire);
    const instructions = estimateTokens(system);
    const latestTokens = prev ? estimateTokens(prev.content) : 0;
    const latest = !prev ? null : after ? describeResult(after, lastCallArgs, prev.content) : 'your message';
    onEvent({ type: 'step', step, promptTokens: total, after, breakdown: { instructions, chat: Math.max(0, total - instructions - latestTokens), latest, latestTokens } });

    try {
      // After an empty reply, ask for a fresh start (engines that cache the conversation drop that cache).
      const opts = { num_ctx: contextBudget, temperature: freshNext ? Math.max(temperature, 0.6) : temperature, fresh: freshNext };
      freshNext = false;
      for await (const chunk of provider.stream({ model, messages: wire, signal: ctrl.signal, options: opts })) {
        if (chunk.type === 'finish') {
          finish = chunk.reason;
          continue;
        }
        // Everything the model writes, unfiltered (for "see what it's doing" views).
        if (chunk.type === 'thinking' || chunk.type === 'text') onEvent({ type: 'raw', delta: chunk.text, thinking: chunk.type === 'thinking' });
        if (chunk.type === 'thinking') {
          nativeThinking += chunk.text;
          onEvent({ type: 'thinking', delta: chunk.text });
          continue;
        }
        if (chunk.type === 'usage') {
          usage = chunk;
          continue;
        }
        raw += chunk.text;
        const a = analyze(raw);
        if (a.thinking.length > sentThink) {
          onEvent({ type: 'thinking', delta: a.thinking.slice(sentThink) });
          sentThink = a.thinking.length;
        }
        const prose = a.call ? a.prose : a.safe;
        if (prose.length > sentProse) {
          onEvent({ type: 'text', delta: prose.slice(sentProse) });
          sentProse = prose.length;
        }
        // Stream the code while the model is still writing it (write_file / edit_file / …).
        if (a.call && !a.call.complete && a.call.partial) {
          const p = a.call.partial;
          const size = Object.values(p.args).reduce((n, v) => n + v.length, 0);
          if (size !== streamedSize) {
            streamedSize = size;
            onEvent({ type: 'tool-stream', name: a.call.name, args: p.args, writing: p.writing });
          }
        }
        if (a.call && !announced) {
          // let UIs show "preparing tool…" while the call streams in
          announced = true;
          onEvent({ type: 'tool-preparing', name: a.call.name });
        }
        if (a.call?.complete) {
          stopForTool = true;
          ctrl.abort();
          break;
        }
      }
    } catch (err) {
      if (!(stopForTool || (signal?.aborted && err?.name === 'AbortError') || signal?.aborted)) {
        onEvent({ type: 'error', error: err?.message || String(err) });
        return { messages, status: 'error' };
      }
    }

    if (usage) onEvent({ type: 'usage', ...usage });
    if (finish) onEvent({ type: 'finish', reason: finish });

    const a = analyze(raw);
    // flush remaining prose
    if (!a.call && a.prose.length > sentProse) onEvent({ type: 'text', delta: a.prose.slice(sentProse) });

    if (signal?.aborted) {
      if (raw.trim()) messages.push({ role: 'assistant', content: a.prose.trim() || '(stopped)' });
      onEvent({ type: 'stopped' });
      return { messages, status: 'stopped' };
    }

    if (!a.call) {
      const text = a.prose.trim();
      if (!text && !a.thinking && !nativeThinking) {
        const full = finish === 'length';
        // Small models sometimes answer with nothing. Ask once more before giving up.
        if (emptyRetries < 1 && !full) {
          emptyRetries++;
          freshNext = true;
          onEvent({ type: 'nudge', text: 'The model sent an empty reply — asking again' });
          continue;
        }
        onEvent({
          type: 'error',
          error: full
            ? "The model ran out of room: this chat is longer than its memory (context window). Start a new chat, or type /compact."
            : 'The model sent an empty reply twice. Try rephrasing, start a new chat, or pick a different model.',
        });
        return { messages, status: 'error' };
      }
      const wantsCode = asksForCode(askedText());
      const canSave = autoSaveCode && !wroteFiles && mode !== 'plan' && !!workspace.write;
      const hasCode = /```|~~~/.test(fenceRawHtml(text)) || parseFindReplace(text).length > 0;

      // Small models sometimes claim they "can't create files". Remind them that Buddo saves files.
      if (canSave && nudges < MAX_NUDGES && wantsCode && isRefusal(text) && !hasCode) {
        nudges++;
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: 'You CAN do this — Buddo saves files for you automatically. Write the complete code now: put each file name on its own line, then the full code in a fenced code block.',
        });
        onEvent({ type: 'nudge', text: 'Reminded the model that it can write files' });
        continue;
      }

      // Only the edit markers came back (e.g. "<<<<<<< SEARCH / ======= / >>>>>>> REPLACE" with no code).
      if (canSave && nudges < MAX_NUDGES && !hasCode && /<{5,}\s*(SEARCH|FIND)/i.test(text)) {
        const t = await readTarget();
        if (t) {
          nudges++;
          messages.push({ role: 'assistant', content: text });
          messages.push({
            role: 'user',
            content:
              nudges === 1 && t.content.length >= SMALL_FILE
                ? `That edit had no code in it. Write the lines to change.\n\n[Current ${t.path}]\n${fence(t.path, t.content)}\n${editHow(t.path)}`
                : `Please write the COMPLETE updated ${t.path} (the whole file) in one code block.\n\n[Current ${t.path}]\n${fence(t.path, t.content)}`,
          });
          onEvent({ type: 'nudge', text: nudges === 1 && t.content.length >= SMALL_FILE ? 'The model wrote the edit markers but no code — showed it an example' : `Asked the model for the whole ${t.path}` });
          continue;
        }
      }

      // Asked for code, got only words (and not a question back): ask for the code.
      if (canSave && nudges < MAX_NUDGES && wantsCode && !hasCode && !/\?\s*$/.test(text) && text.length < 1500) {
        nudges++;
        const shown = isNewBuild(askedText()) ? [] : await editFilesToShow();
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: shown.length
            ? `${CLAIMS_DONE.test(text) ? 'Nothing in the project changed yet: no code was written. ' : ''}Write the change now.\n\n${showFiles(shown)}\n${askChange(shown.map((f) => f.path))}`
            : 'Write the code now: put the file name on its own line, then the complete code in a fenced code block.',
        });
        onEvent({ type: 'nudge', text: 'The model only answered in words — asked it for the code' });
        continue;
      }

      messages.push({ role: 'assistant', content: text || a.thinking.trim() });
      if (!text && a.thinking) onEvent({ type: 'text', delta: a.thinking.trim() });

      // The model answered with find/replace blocks → apply each one with edit_file.
      const changes = canSave ? parseFindReplace(text) : [];
      if (changes.length) {
        const target = await readTarget();
        const saved = [];
        const failed = [];
        for (const c of changes.slice(0, 12)) {
          if (/^<p>Old text<\/p>$/.test(c.find.trim()) && /^<p>New text<\/p>$/.test(c.replace.trim())) {
            failed.push('That was the example, copied. Write the change for this request instead.');
            continue;
          }
          const path = c.path || target?.path;
          if (!path) {
            failed.push('An edit had no file name. Write the file name on the line above <<<<<<< SEARCH.');
            continue;
          }
          const exists = (await workspace.read(path).catch(() => null)) !== null;
          // An empty SEARCH for a file that doesn't exist yet means "create it".
          const call = !c.find.trim() && !exists
            ? { id: `t${Date.now().toString(36)}${id++}`, name: 'write_file', args: { path, content: c.replace.replace(/\s*$/, '\n') }, auto: true }
            : { id: `t${Date.now().toString(36)}${id++}`, name: 'edit_file', args: { path, old: c.find, new: c.replace }, auto: true };
          onEvent({ type: 'tool-start', call, kind: 'write', auto: true });
          const result = c.find.trim() || !exists ? await perform(call, TOOL_MAP[call.name]) : { ok: false, output: `The SEARCH part for ${path} was empty. Copy the lines to change from the file.` };
          if (!result) {
            onEvent({ type: 'tool-end', id: call.id, ok: false, output: 'Stopped.' });
            onEvent({ type: 'stopped' });
            return { messages, status: 'stopped' };
          }
          onEvent({ type: 'tool-end', id: call.id, ok: result.ok, output: result.output, display: result.display, denied: result.denied });
          if (result.ok) saved.push(`${path} (edited)`);
          else if (!result.denied) failed.push(result.output);
        }
        if (saved.length) messages[messages.length - 1].content += `\n\n[Buddo saved these code blocks as files: ${saved.join(', ')}]`;
        // Nothing applied: show the file again and ask once for exact SEARCH lines, then for the whole file.
        const now = target && (await workspace.read(target.path).catch(() => null));
        if (!saved.length && failed.length && now !== null && target && nudges < MAX_NUDGES) {
          nudges++;
          const retry = nudges === 1 && now.length >= SMALL_FILE;
          messages.push({
            role: 'user',
            content:
              retry
                ? `That edit didn't apply: ${failed[0]}\n\n[Current ${target.path}]\n${fence(target.path, now)}\n${editHow(target.path)}`
                : `Please write the COMPLETE updated ${target.path} (the whole file) in one code block.\n\n[Current ${target.path}]\n${fence(target.path, now)}`,
          });
          onEvent({ type: 'nudge', text: retry ? `The model's edit didn't match ${target.path} — asked it to try again` : `Asked the model for the whole ${target.path}` });
          continue;
        }
        if (!saved.length && failed.length) return nothingSaved(`the model's edit didn't match ${target?.path || 'the file'}`, text);
        if (failed.length) onEvent({ type: 'nudge', text: `One edit didn't apply: ${failed[0]}` });
        onEvent({ type: 'done' });
        return { messages, status: 'done' };
      }

      // The model answered with plain code blocks instead of tool calls → save them as files.
      if (canSave) {
        let files = extractCodeFiles(text || a.thinking, { wantsCode, diffs: !!removal() }).filter((f) => wantsCode || !f.inferred);
        const editFiles = files.length ? await readEditFiles() : [];
        const [target, ...related] = editFiles;
        const edit = !!target && !isNewBuild(askedText());
        if (files.some((f) => copiedExample(f.content)) && !/\bhello\b/i.test(askedText())) {
          if (nudges >= MAX_NUDGES) return nothingSaved('the model copied the example page from its instructions instead of what you asked', text);
          nudges++;
          const shown = edit ? editFiles.filter((f) => f.content.length < 9000) : [];
          messages.push({
            role: 'user',
            content: `That is the example page from your instructions, copied. It is not what was asked. Write the code for this request instead: "${askedText()}".${shown.length ? `\n\n${showFiles(shown)}\n${askChange(shown.map((f) => f.path))}` : ' Put the file name on its own line, then the complete code in a fenced code block.'}`,
          });
          onEvent({ type: 'nudge', text: 'The model copied the example page instead of doing what you asked — asked it again' });
          continue;
        }
        // Asked for a color ("a green button") but the code never sets it: it only wrote the word on the button.
        const visual = files.filter((f) => /^(html?|css|s[ac]ss|less|m?jsx?|tsx?|vue|svelte)$/.test(f.lang));
        const noColor = visual.length && !removal() ? missingColors(askedText(), visual) : [];
        if (noColor.length && nudges < MAX_NUDGES) {
          nudges++;
          const c = noColor.join(' and ');
          const shown = edit ? editFiles.filter((f) => f.content.length < 9000) : [];
          messages.push({
            role: 'user',
            content: `Nothing in your code is ${c}: writing the word "${noColor[0]}" doesn't color anything. The request was "${askedText()}". Set the color in the CSS, for example background-color: ${noColor[0]};${shown.length ? `\n\n${showFiles(shown)}\n${askChange(shown.map((f) => f.path))}` : ' Write the code again: the file name on its own line, then the complete code in a fenced code block.'}`,
          });
          onEvent({ type: 'nudge', text: `Nothing in the model's code was ${c} — asked it to actually set the color` });
          continue;
        }
        // A new page with its own CSS/JS: make sure the page loads them.
        if (!edit) files = linkAssets(files);
        const { writes, needFull, unchanged = [] } = await planCodeSave(files, {
          target,
          related,
          edit,
          removing: asksToRemove(askedText()),
          removal: edit ? removal() : null,
          read: (p) => workspace.read(p),
        });
        // The model sent the file back as it already was: say so (it usually thinks it made the change).
        if (unchanged.length && !writes.length && !needFull && target && nudges < MAX_NUDGES) {
          nudges++;
          const shown = editFiles.filter((f) => f.content.length < 9000);
          messages.push({
            role: 'user',
            content: `Nothing changed: your ${unchanged.join(', ')} is exactly the same as the current file${removal() ? ', so nothing was removed' : ''}. Make the change that was asked.\n\n${showFiles(shown)}\n${askChange(shown.map((f) => f.path))}`,
          });
          onEvent({ type: 'nudge', text: `The model's ${unchanged.join(', ')} was the same as before — asked it to make the change` });
          continue;
        }
        // Buddo couldn't tell where the lines go (or the model left parts out): ask again for just the
        // changed lines with a line of context; only as a last resort for the whole file (still saved as line edits).
        if (needFull && !writes.length && target && nudges < MAX_NUDGES) {
          nudges++;
          const shown = editFiles.filter((f) => f.content.length < 9000);
          const rm = removal();
          messages.push({
            role: 'user',
            content:
              nudges === 1
                ? rm
                  ? `I couldn't tell which lines to delete. Copy them exactly from the file.\n\n${showFiles(shown)}\n${askRemove(rm, shown.map((f) => f.path))}`
                  : `I couldn't tell where those lines go. Write them again with one unchanged line above and below each change, under the file name. Never leave parts out with "..." comments.\n\n${showFiles(shown)}\n${askEdit(shown.map((f) => f.path))}`
                : rm
                  ? `Please write the COMPLETE ${target.path} as it should end up, in one code block: every line that stays, copied exactly, with only the removed parts left out.\n\n${showFiles([target])}`
                  : `Please write the COMPLETE updated ${target.path} (the whole file, nothing left out) in one code block.\n\n${showFiles([target])}`,
          });
          onEvent({
            type: 'nudge',
            text: nudges === 1 ? (rm ? `Couldn't tell which lines of ${target.path} to remove — asked the model again` : `Couldn't place the model's lines in ${target.path} — asked it to show where they go`) : `Asked the model for the whole ${target.path}`,
          });
          continue;
        }
        const saved = [];
        let declined = false;
        for (const f of writes.slice(0, 12)) {
          // A rewrite of an existing file: apply just the lines it changes, one edit per spot.
          if (f.edits?.length) {
            let ok = true;
            let denied = false;
            for (const e of f.edits) {
              const call = { id: `t${Date.now().toString(36)}${id++}`, name: 'edit_file', args: { path: f.path, old: e.old, new: e.new }, auto: true, merged: true };
              onEvent({ type: 'tool-start', call, kind: 'write', auto: true });
              const result = await perform(call, TOOL_MAP.edit_file);
              if (!result) {
                onEvent({ type: 'tool-end', id: call.id, ok: false, output: 'Stopped.' });
                onEvent({ type: 'stopped' });
                return { messages, status: 'stopped' };
              }
              onEvent({ type: 'tool-end', id: call.id, ok: result.ok, output: result.output, display: result.display, denied: result.denied });
              if (!result.ok) {
                ok = false;
                denied = !!result.denied;
                break;
              }
            }
            if (denied) {
              declined = true;
              continue;
            }
            if (ok) {
              saved.push(`${f.path} (edited)`);
              continue;
            }
            f.edits = null; // fall back to saving the whole file below
          }
          let call = f.edit
            ? { id: `t${Date.now().toString(36)}${id++}`, name: 'edit_file', args: { path: f.path, old: f.edit.old, new: f.edit.new }, auto: true, merged: true }
            : { id: `t${Date.now().toString(36)}${id++}`, name: 'write_file', args: { path: f.path, content: f.content }, auto: true, merged: !!f.merged };
          onEvent({ type: 'tool-start', call, kind: 'write', auto: true });
          let result = await perform(call, TOOL_MAP[call.name]);
          // The changed block appears twice in the file: save the merged file instead.
          if (result && !result.ok && !result.denied && f.edit) {
            onEvent({ type: 'tool-end', id: call.id, ok: false, output: result.output });
            call = { id: `t${Date.now().toString(36)}${id++}`, name: 'write_file', args: { path: f.path, content: f.content }, auto: true, merged: true };
            onEvent({ type: 'tool-start', call, kind: 'write', auto: true });
            result = await perform(call, TOOL_MAP.write_file);
          }
          if (!result) {
            onEvent({ type: 'tool-end', id: call.id, ok: false, output: 'Stopped.' });
            onEvent({ type: 'stopped' });
            return { messages, status: 'stopped' };
          }
          if (result.ok) saved.push(f.path + (f.truncated ? ' (may be cut off)' : ''));
          if (result.denied) declined = true;
          onEvent({ type: 'tool-end', id: call.id, ok: result.ok, output: result.output, display: result.display, denied: result.denied });
        }
        if (saved.length) messages[messages.length - 1].content += `\n\n[Buddo saved these code blocks as files: ${saved.join(', ')}]`;
        if (saved.length && noColor.length) onEvent({ type: 'nudge', text: `Heads up: nothing in the saved code is ${noColor.join(' or ')} — the model may only have written the word. Try a bigger model, or ask again.` });
        // Asked for a change, nothing landed: never let "Done! I removed it" stand.
        if (!saved.length && !declined && wantsCode && (files.length || (CLAIMS_DONE.test(text) && (removal() || looksLikeEdit(askedText()))))) {
          const echoed = repeatsInstructions(text);
          // Before giving up, say what went wrong and ask once more (tiny models often get it on the next try).
          if (nudges < MAX_NUDGES && !unchanged.length && !needFull) {
            nudges++;
            const shown = isNewBuild(askedText()) ? [] : await editFilesToShow();
            messages.push({
              role: 'user',
              content: `${echoed ? 'That is part of your own instructions, copied. It is not code for the request.' : 'Nothing in the project changed: your reply had no code for the change.'} The request was "${askedText()}".${shown.length ? `\n\n${showFiles(shown)}\n${askChange(shown.map((f) => f.path))}` : ' Write the code now: the file name on its own line, then the complete code in a fenced code block.'}`,
            });
            onEvent({ type: 'nudge', text: echoed ? 'The model repeated its instructions instead of writing code — asked it again' : 'The model wrote no code for the change — asked it again' });
            continue;
          }
          const why = echoed
            ? 'the model repeated its own instructions instead of writing code'
            : unchanged.length
            ? `the code it sent is the same as ${unchanged.join(', ')} already was`
            : needFull && target
              ? removal()
                ? `Buddo couldn't tell which lines of ${target.path} to remove`
                : `Buddo couldn't tell where the model's code goes in ${target.path}`
              : files.length
                ? "the model's code didn't change any file"
                : hasCode
                  ? "the model's code wasn't for any of your files"
                  : 'the model wrote no code';
          return nothingSaved(why, text);
        }
      }
      onEvent({ type: 'done' });
      return { messages, status: 'done' };
    }

    // Keep only what the model said up to (and including) its tool call.
    const visibleUpToCall = (() => {
      const { visible } = splitThinking(raw);
      return a.call.end ? visible.slice(0, a.call.end) : visible;
    })();
    messages.push({ role: 'assistant', content: visibleUpToCall.trim() });

    if (!a.call.complete) {
      incomplete++;
      if (incomplete > 2) {
        onEvent({ type: 'error', error: 'The model keeps producing incomplete tool calls. Try a larger model.' });
        return { messages, status: 'error' };
      }
      messages.push({ role: 'user', content: `<tool_result name="${a.call.name}">\nError: your tool call was cut off. Write the complete call again, ending with </tool:${a.call.name}>.\n</tool_result>` });
      continue;
    }

    const call = { id: `t${Date.now().toString(36)}${id++}`, name: a.call.name, args: a.call.args };
    const tool = TOOL_MAP[call.name];
    onEvent({ type: 'tool-start', call, kind: tool?.kind });

    const sig = call.name + JSON.stringify(call.args);
    repeats = sig === lastSig ? repeats + 1 : 0;
    lastSig = sig;

    lastCallArgs = call.args;
    const result = await perform(call, tool);
    if (!result) {
      onEvent({ type: 'tool-end', id: call.id, ok: false, output: 'Stopped.' });
      onEvent({ type: 'stopped' });
      return { messages, status: 'stopped' };
    }

    let output = result.output;
    if (repeats >= 2) output += '\n\nNote: you have made this exact call several times. Do something different or finish.';
    const images = result.images?.length ? result.images : undefined;
    if (images && !vision) output += '\n(Your current model can\'t see the attached image — use the text description above.)';
    messages.push({ role: 'user', content: `<tool_result name="${call.name}">\n${output}\n</tool_result>`, ...(images && vision ? { images } : {}) });
    onEvent({ type: 'tool-end', id: call.id, ok: result.ok, output: result.output, display: result.display, denied: result.denied });
  }

  onEvent({ type: 'error', error: `Stopped after ${maxSteps} steps. Say "continue" to keep going.` });
  return { messages, status: 'max-steps' };
}

/**
 * After a chat, ask the model (quietly, no tools) what new lasting facts it learned about the user.
 * Returns an array of short facts (possibly empty).
 */
export async function learnAboutUser({ provider, model, profile, userTexts, signal, temperature = 0 }) {
  const text = userTexts.join('\n---\n').slice(-4000);
  if (text.replace(/\s/g, '').length < 25) return [];
  const known = normalizeProfile(profile).memories.map((m) => m.text);
  let out = '';
  for await (const chunk of provider.stream({ model, messages: [{ role: 'user', content: LEARN_PROMPT(known, text) }], signal, options: { temperature, num_ctx: 4096 } })) {
    if (chunk.type === 'text') out += chunk.text;
    if (out.length > 2000) break;
  }
  return parseLearned(out.replace(/<think>[\s\S]*?<\/think>/g, ''));
}
