// The agent loop: stream model output → detect a tool call → (ask permission) →
// execute → feed the result back → repeat until the model answers without tools.

import { analyze, splitThinking } from './parser.js';
import { executeTool, TOOL_MAP } from './tools.js';
import { buildSystemPrompt, filesNote, toolSchemas, availableTools } from './prompt.js';
import { toolCallText, forcedCallSchema, parseForcedCall, promisesAction, findLoop, dropRepeats, sameAnswer, PROTOCOL_EXAMPLE, strictReplySchema, readStrictReply, parseStrictReply } from './behave.js';
import { formatTree } from './tree.js';
import { LEARN_PROMPT, parseLearned, normalizeProfile } from './personality.js';
import { missingColors } from './colors.js';
import { quickChange } from './quick.js';
import { attachedMedia, requestText, wantsVideoEdit, planQuickVideo } from './quick-video.js';
import { extractCodeFiles, asksForCode, isRefusal, fenceRawHtml, linkAssets } from './codeblocks.js';
import { planCodeSave, looksLikeEdit, isNewBuild, parseFindReplace, linkedFiles, asksToRemove, rewriteAsEdits, removalKind, keepOnlyRemovals, hasPlaceholders, requestedLanguage, isWebFile } from './edits.js';

export const estimateTokens = (s) => Math.ceil((s || '').length / 3.6);

// "I removed the title", "The button has been updated", "Done!": the reply says the change is made.
const CLAIMS_DONE = /\b(?:i(?:'ve|’ve| have)?|has been|have been|is now|are now)\s+(?:now\s+)?(?:removed|deleted|changed|updated|made|added|replaced|edited|fixed|modified|cleaned|moved|renamed|turned|styled)\b|^\s*(?:all )?done\b/im;

// The example page in the lite prompt (<h1>Hello</h1>), sent back instead of what was asked (seen on a phone:
// "add a green button" → a page that says Hello).
const copiedExample = (code = '') =>
  code.replace(/<!doctype[^>]*>|<\/?(?:html|head|body)\b[^>]*>|<meta\b[^>]*>|<title>[\s\S]*?<\/title>|\s+/gi, '').toLowerCase() === '<h1>hello</h1>' ||
  code.trim() === 'print("Hi")';

// "Tests pass", "I ran it": only true when a command actually ran.
const CLAIMS_RAN = /\b(?:i(?:'ve|’ve| have)? (?:ran|run|tested|executed)|tests? (?:all )?(?:pass(?:ed|es)?|succeed(?:ed)?)|it (?:works|runs) (?:now|fine|correctly))\b/i;

// "How do I…", "Why is…": a question, answered in words (never forced into a tool).
const QUESTION_START = /^\s*(what|why|how|when|where|who|which|explain|is|are|does|do|did|can|could|should|would)\b/i;

// What each model can do (Ollama's /api/show), asked once per model.
const capsCache = new Map();
async function modelCapabilities(provider, model) {
  const key = `${provider.id}:${model}`;
  if (!capsCache.has(key)) capsCache.set(key, Promise.resolve(provider.modelInfo?.(model)).then((i) => i?.capabilities || []).catch(() => []));
  return capsCache.get(key);
}

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
  // Every file that exists, so the prompt can say exactly which ones there are (models invent files otherwise).
  let files = null;
  try {
    const entries = await workspace.list('.', 2);
    tree = formatTree(entries, '.', 150);
    names = new Set(entries.map((e) => e.path));
    files = (await workspace.list('.', 8).catch(() => entries)).filter((e) => e.type === 'file').map((e) => e.path);
  } catch {}
  for (const f of ['BUDDO.md', 'buddo.md', 'CLAUDE.md', 'AGENTS.md']) {
    if (names && !names.has(f)) continue;
    try {
      memory = (await workspace.read(f)).slice(0, 6000);
      if (memory) break;
    } catch {}
  }
  return { tree, memory, files };
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
  // 'auto': built-in tool calling for models that support it (Ollama says "tools"); true / false to force it.
  nativeTools = 'auto',
  // Strict replies: every reply is a JSON object the engine enforces token by token (Ollama's `format`), so the
  // model can't skip the tools; a build request can't even finish before a file is written. 'auto': on for
  // engines that support it (Ollama), except tiny models in lite mode.
  strictTools = 'auto',
}) {
  const ctx = context || (await gatherContext(workspace));
  const strict = strictTools === true || (strictTools === 'auto' && !lite && !!provider.supports?.format);
  const native =
    !strict && !lite && nativeTools !== false && !!provider.supports?.tools && (nativeTools === true || (nativeTools === 'auto' && provider.id === 'ollama' && (await modelCapabilities(provider, model)).includes('tools')));
  const schemas = native ? toolSchemas(workspace, { profile }) : null;
  // A reply that only promises to act ("I'll create main.py") is asked again with its answer forced into a tool
  // call: the engine only lets it write {"tool": …, "args": …}.
  const forceTools = availableTools(workspace, { lite, profile });
  const canForce = !strict && !!provider.supports?.format && mode !== 'plan';
  let forceNext = null;
  let forced = 0;
  let ranCommand = false;
  let repeatNudged = false;
  // The file list rides along with the user's message, not in the system prompt: the prompt stays word for word the
  // same between messages, so Ollama / llama.cpp reuse what they already read (the "reading your message" wait).
  const system = buildSystemPrompt({ workspace, mode, vision, profile, lite, thinkAloud, ...ctx, filesInSystem: false, nativeTools: native, strictTools: strict });
  const note = filesNote(ctx, { lite });
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
  // The message the file list is attached to (on the wire only, never saved in the chat).
  const requestMsg = lastUserMsg();
  // New files the user's message names: a strict reply can't say "done" until each one is written.
  const namedFiles = [];
  if (strict) {
    for (const m of asked.split('\n\n[Current ')[0].matchAll(/(?:^|[\s@`'"(,])((?:[\w-]+\/)*[\w-]+\.(?:html?|css|m?js|jsx|tsx?|py|json|md|txt|java|go|rs|rb|php|sh|c|cpp|cs|kt|swift|lua|sql|yml|yaml|toml))(?=$|[\s`'"),.:;!?])/gi)) {
      if (!namedFiles.includes(m[1]) && (await workspace.read(m[1]).catch(() => null)) === null) namedFiles.push(m[1]);
    }
  }
  const askedText = () => asked;

  // A request for another language ("write a python script") is never about the chat's web page.
  const language = requestedLanguage(asked);
  /**
   * The file this conversation is working on: a file the message names, else the last file of the asked-for
   * language written here (main.py for "fix the python script"), else the last HTML page / the project's index.html.
   */
  const findTarget = async () => {
    const named = [...asked.matchAll(/(?:^|[\s@`'"(])((?:[\w-]+\/)*[\w.-]+\.[a-z0-9]{1,5})(?=$|[\s`'"),.:;!?])/gi)].map((m) => m[1]);
    for (const n of named) if ((await workspace.read(n).catch(() => null)) !== null) return n;
    const want = language ? new RegExp(`\\.${language}$`, 'i') : /\.html?$/i;
    for (let i = messages.length - 1; i >= 0; i--) {
      const c = messages[i].content || '';
      const saved = /\[Buddo saved these code blocks as files: ([^\]]+)\]/.exec(c)?.[1]?.split(',').map((x) => x.trim().replace(/ \(.*\)$/, '')) || [];
      const written = [...c.matchAll(/<tool:write_file>\s*<path>([^<]+)<\/path>/g)].map((m) => m[1].trim());
      const hit = [...saved, ...written].reverse().find((n) => want.test(n));
      if (hit) return hit;
    }
    if (language) {
      const all = await workspace.glob?.(`**/*.${language}`).catch(() => []);
      return all?.length === 1 ? all[0] : all?.find((f) => /^(main|app|index|script)\./i.test(f)) || null;
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
  const wroteThisTurn = new Set();
  const rewrites = new Map();
  const seen = new Map();
  let missingReads = 0;
  /** Save the complete, named code blocks in `text` as files (new files, or whole-file rewrites). Returns the paths. */
  const saveCodeBefore = async (text) => {
    if (!/```|~~~/.test(text)) return [];
    let files = extractCodeFiles(text, { wantsCode: true }).filter((f) => !f.inferred && f.path && f.content?.trim() && !hasPlaceholders(f.content));
    if (!files.length) return [];
    if (isNewBuild(askedText())) files = linkAssets(files);
    const saved = [];
    for (const f of files.slice(0, 12)) {
      const before = await workspace.read(f.path).catch(() => null);
      if (before !== null && before.replace(/\s+/g, ' ').trim() === f.content.replace(/\s+/g, ' ').trim()) continue;
      // An existing file the user asked to change gets the careful edit path at the end of the reply instead.
      if (before !== null && !createdHere.has(f.path) && !isNewBuild(askedText())) continue;
      const call = { id: `t${Date.now().toString(36)}${id++}`, name: 'write_file', args: { path: f.path, content: f.content }, auto: true };
      onEvent({ type: 'tool-start', call, kind: 'write', auto: true });
      const result = await perform(call, TOOL_MAP.write_file);
      onEvent({ type: 'tool-end', id: call.id, ok: !!result?.ok, output: result?.output || 'Stopped.', display: result?.display, denied: result?.denied });
      if (result?.ok) {
        saved.push(f.path);
        wroteThisTurn.add(f.path);
        createdHere.add(f.path);
      }
    }
    return saved;
  };
  let incomplete = 0;
  let id = 0;

  // Small models can't write video edit steps (they refuse, or write a web page instead): for "make this a TikTok
  // with a hook title and sound effects", Buddo watches the attached video and plans the edit itself.
  if (lite && mode !== 'plan' && workspace.media?.edit_video && workspace.media?.watch_video) {
    const msg = lastUserMsg();
    const { videos, audios } = msg && msg === messages[messages.length - 1] ? attachedMedia(messages) : { videos: [] };
    const request = msg ? requestText(asked) : '';
    if (videos.length && wantsVideoEdit(request, { attachedNow: /\[Attached video:/.test(msg.content) })) {
      const run = async (name, args) => {
        const call = { id: `t${Date.now().toString(36)}${id++}`, name, args, auto: true, quick: true };
        onEvent({ type: 'tool-start', call, kind: TOOL_MAP[name].kind, auto: true });
        const result = await perform(call, TOOL_MAP[name]);
        onEvent({ type: 'tool-end', id: call.id, ok: !!result?.ok, output: result?.output || 'Stopped.', display: result?.display, denied: result?.denied });
        return result;
      };
      const say = (text, status = 'done') => {
        onEvent({ type: 'text', delta: text });
        messages.push({ role: 'assistant', content: text });
        onEvent({ type: status });
        return { messages, status };
      };
      // Watch every clip: its length, and the loudest moment (the best part to put effects on).
      let duration = 0;
      let loudest = null;
      for (const v of videos) {
        const seen = await run('watch_video', { path: v });
        if (!seen) return say('Stopped.', 'stopped');
        if (!seen.ok) return say(`I couldn't open ${v}: ${seen.output.replace(/^Error:\s*/, '')}`);
        const len = /— (\d+):(\d+(?:\.\d+)?) long/.exec(seen.output);
        const peak = /loudest at (\d+):(\d+(?:\.\d+)?)/.exec(seen.output);
        if (peak && loudest === null) loudest = duration + Number(peak[1]) * 60 + Number(peak[2]);
        duration += len ? Number(len[1]) * 60 + Number(len[2]) : 0;
      }
      const plan = planQuickVideo(request, { videos, audios, duration, loudest, canCaption: !!workspace.media.listen_audio });
      if (plan) {
        const done = await run('edit_video', { input: plan.input, steps: plan.steps, out: plan.out });
        if (!done) return say('Stopped.', 'stopped');
        if (done.denied) return say('Okay, I left the video as it was.');
        if (!done.ok) return say(`The edit didn't work: ${done.output.replace(/^Error:\s*/, '')}`, 'done');
        return say(
          [
            `Done! Saved **${plan.out}** 🎬`,
            '',
            ...plan.did.map((d) => `- ${d}`),
            ...plan.notes.map((n) => `- ⚠️ ${n}`),
            '',
            'Want your own words? Say something like: make it a TikTok with the title "POV: me rn" and "no way" on the best part.',
          ].join('\n'),
        );
      }
    }
  }

  // Simple requests ("add a green button", "make the button blue", "remove the heading"): Buddo does them itself,
  // exactly, so no model can overdo them, miss them or rewrite the file. Everything else goes to the model.
  if (quickEdits && autoSaveCode && mode !== 'plan' && workspace.write && !language) {
    const msg = lastUserMsg();
    if (msg && msg === messages[messages.length - 1]) {
      // Without the files an @mention attached; a mentioned page is the one to change.
      const request = asked.split(/\n\n(?:<file path=|\()/)[0].replace(/(^|\s)@[\w./-]+/g, ' ').trim();
      const mentioned = /(?:^|\s)@([\w./-]+\.html?)\b/i.exec(asked)?.[1];
      const all = mentioned ? [{ path: mentioned, content: await workspace.read(mentioned).catch(() => null) }].filter((f) => f.content !== null) : await readEditFiles();
      const [page0 = null, ...files] = all;
      const page = page0 && /\.html?$/i.test(page0.path) ? page0 : null;
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
    let loopAt = -1;
    const forcing = forceNext;
    forceNext = null;

    const at = messages.indexOf(requestMsg);
    // Models on Buddo's text protocol see one tiny worked example first (they copy patterns better than rules).
    const wire = [{ role: 'system', content: system }, ...(native || strict || lite ? [] : PROTOCOL_EXAMPLE), ...compactForModel(slimHistory(messages), contextBudget).map((m, i) => (i === at && note ? { ...m, content: `${m.content}\n\n${note}` } : m))].map((m) =>
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
      if (strict) {
        // Asked to make or change something and nothing is written yet: "done" isn't an option (for a few steps,
        // so a model that really can't still gets to say why).
        const canWrite = mode !== 'plan' && autoSaveCode && !!workspace.write;
        // Files the request names ("index.html, styles.css and script.js") must all be written before it's done.
        const missing = canWrite && step < 12 ? namedFiles.filter((f) => !wroteThisTurn.has(f)) : [];
        const mustAct = missing.length > 0 || (canWrite && !wroteFiles && step < 6 && (isNewBuild(askedText()) || looksLikeEdit(askedText()) || !!removal()) && !QUESTION_START.test(askedText()));
        opts.format = strictReplySchema(forceTools, { allowDone: !mustAct, think: thinkAloud });
      } else if (forcing) opts.format = forcedCallSchema(forceTools);
      else if (schemas) opts.tools = schemas;
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
        // A strict reply streams in as JSON: show its "say" (and the code being written) as it arrives.
        if (strict) {
          if (chunk.type !== 'text') continue;
          raw += chunk.text;
          const r = readStrictReply(raw);
          if (r.think.length > sentThink) {
            onEvent({ type: 'thinking', delta: r.think.slice(sentThink) });
            sentThink = r.think.length;
          }
          if (r.say.length > sentProse) {
            onEvent({ type: 'text', delta: r.say.slice(sentProse) });
            sentProse = r.say.length;
          }
          if (r.tool && r.tool !== 'done' && r.argsAt !== -1) {
            if (!announced) {
              announced = true;
              onEvent({ type: 'tool-preparing', name: r.tool });
            }
            const size = Object.values(r.args).reduce((n, v) => n + v.length, 0);
            if (size !== streamedSize) {
              streamedSize = size;
              onEvent({ type: 'tool-stream', name: r.tool, args: r.args, writing: r.args.content !== undefined ? 'content' : null });
            }
          }
          if (findLoop(r.say) >= 0) {
            loopAt = findLoop(r.say);
            ctrl.abort();
            break;
          }
          continue;
        }
        // A forced reply is JSON: collect it quietly, it becomes a tool call below.
        if (forcing) {
          if (chunk.type === 'text') raw += chunk.text;
          continue;
        }
        // Built-in tool calling: the call arrives whole; write it in the text protocol so everything after is the same.
        if (chunk.type === 'tool_call') {
          if (!chunk.name) continue;
          const t = toolCallText(chunk.name, chunk.args);
          raw += `${raw.trim() ? '\n\n' : ''}${t}`;
          onEvent({ type: 'raw', delta: t });
        } else raw += chunk.text;
        const a = analyze(raw);
        // Going round in circles ("I will now… I will now… I will now…"): stop it here.
        if (!a.call) {
          const cut = findLoop(a.prose);
          if (cut >= 0) {
            loopAt = cut;
            ctrl.abort();
            break;
          }
        }
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
      if (!(stopForTool || loopAt >= 0 || (signal?.aborted && err?.name === 'AbortError') || signal?.aborted)) {
        onEvent({ type: 'error', error: err?.message || String(err) });
        return { messages, status: 'error' };
      }
    }

    if (usage) onEvent({ type: 'usage', ...usage });
    if (finish) onEvent({ type: 'finish', reason: finish });

    // The strict reply becomes what the rest of the loop knows: the words, then the tool call in the text protocol.
    if (strict && raw.trim()) {
      const j = parseStrictReply(raw);
      if (j) {
        const call = j.tool !== 'done' && forceTools.some((t) => t.name === j.tool) ? toolCallText(j.tool, j.args) : '';
        raw = `${j.say.trim()}${call ? `${j.say.trim() ? '\n\n' : ''}${call}` : ''}`;
        sentProse = Math.min(sentProse, j.say.trim().length);
      } else if (loopAt < 0) {
        // Cut off before the JSON closed (out of room): keep what it said, and the call so far if it has one.
        const r = readStrictReply(raw);
        raw = r.tool && r.tool !== 'done' ? `${r.say.trim()}\n\n<tool:${r.tool}>` : r.say.trim();
      } else raw = readStrictReply(raw).say;
    }
    if (forcing) {
      const fc = parseForcedCall(raw, forceTools.map((t) => t.name));
      raw = fc ? `${forcing.prose}\n\n${toolCallText(fc.name, fc.args)}` : forcing.prose;
      sentProse = forcing.prose.length;
      if (fc) onEvent({ type: 'raw', delta: `\n${toolCallText(fc.name, fc.args)}` });
    }
    if (loopAt >= 0) {
      const prose = analyze(raw).prose;
      raw = prose.slice(0, loopAt).trimEnd();
      onEvent({ type: 'text-replace', remove: sentProse, text: raw });
      sentProse = raw.length;
      onEvent({ type: 'nudge', text: 'The model started repeating itself — Buddo cut it off there' });
    }
    const a = analyze(raw);
    // flush remaining prose
    if (!a.call && a.prose.length > sentProse) onEvent({ type: 'text', delta: a.prose.slice(sentProse) });

    if (signal?.aborted) {
      if (raw.trim()) messages.push({ role: 'assistant', content: a.prose.trim() || '(stopped)' });
      onEvent({ type: 'stopped' });
      return { messages, status: 'stopped' };
    }

    if (!a.call) {
      let text = a.prose.trim();
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

      // Never say the same thing twice: paragraphs it already wrote in this reply go.
      const once = dropRepeats(text);
      if (once !== text) {
        onEvent({ type: 'text-replace', remove: sentProse, text: once });
        sentProse = once.length;
        text = once;
      }
      // It promised to act, said it was done, or answered a build request with only words: make it call a tool.
      const hollow = !hasCode && !/\?\s*$/.test(text) && (promisesAction(text) || (!wroteFiles && CLAIMS_DONE.test(text) && (wantsCode || looksLikeEdit(askedText()))) || (native && canSave && (isNewBuild(askedText()) || looksLikeEdit(askedText())) && !/^\s*(what|why|how|when|where|who|which|explain|is|are|does|do|can|could|should)\b/i.test(askedText())));
      if (hollow && canForce && forced < 2 && (canSave || promisesAction(text))) {
        forced++;
        forceNext = { prose: text };
        onEvent({ type: 'nudge', text: promisesAction(text) ? 'The model said it would do something but didn\'t — making it use a tool' : 'The model answered in words — making it use a tool' });
        continue;
      }
      // The same answer it already gave earlier in the chat: ask once for an answer to this message instead.
      const before = messages.slice(0, messages.indexOf(requestMsg)).filter((m) => m.role === 'assistant').slice(-3);
      if (!hasCode && !repeatNudged && before.some((m) => sameAnswer(text, m.content))) {
        repeatNudged = true;
        onEvent({ type: 'text-replace', remove: sentProse, text: '' });
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: `You already said that earlier, almost word for word. Don't repeat it. Answer this message instead: "${askedText()}"` });
        onEvent({ type: 'nudge', text: 'The model repeated an earlier answer — asked it for a new one' });
        continue;
      }
      // Honesty: it says it ran something, but no command ran.
      if (CLAIMS_RAN.test(text) && !ranCommand && !hasCode) onEvent({ type: 'nudge', text: "Heads up: the reply says something was run or tested, but no command ran in this reply." });

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
        // Asked for Python (or another language) and got only a web page back: small models default to HTML.
        const wrongKind = language && files.length && !files.some((f) => !isWebFile(f.path || `x.${f.lang}`));
        if (wrongKind && nudges < MAX_NUDGES) {
          nudges++;
          messages.push({
            role: 'user',
            content: `That is ${files.map((f) => f.path).filter(Boolean).join(', ') || 'web code'}, but the request was for a .${language} file: "${askedText()}". Don't make a web page. Write the ${language} file: its name on its own line (for example main.${language}), then the complete code in a \`\`\`${language === 'py' ? 'python' : language} code block.`,
          });
          onEvent({ type: 'nudge', text: `The model wrote a web page instead of a .${language} file — asked it again` });
          continue;
        }
        if (files.some((f) => copiedExample(f.content)) && !/\b(hello|hi)\b/i.test(askedText())) {
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

    // Files the model wrote as code blocks before this tool call are saved right now, not when the reply ends:
    // otherwise its "read index.html" fails, it thinks the page was never made, and writes it again (and again).
    const savedFirst = autoSaveCode && mode !== 'plan' && workspace.write ? await saveCodeBefore(visibleUpToCall.slice(0, a.call.start ?? visibleUpToCall.length)) : [];

    const call = { id: `t${Date.now().toString(36)}${id++}`, name: a.call.name, args: a.call.args };
    const tool = TOOL_MAP[call.name];
    onEvent({ type: 'tool-start', call, kind: tool?.kind });

    const sig = call.name + JSON.stringify(call.args);
    repeats = sig === lastSig ? repeats + 1 : 0;
    lastSig = sig;

    // Small models often "apologise" and write the very same file again after it was saved — forever. A write that
    // changes nothing means the work is already done: finish instead of asking the model again.
    const finishWith = (text) => {
      onEvent({ type: 'tool-end', id: call.id, ok: true, output: 'Skipped: nothing would change.' });
      onEvent({ type: 'text', delta: text });
      messages.push({ role: 'assistant', content: text });
      onEvent({ type: 'done' });
      return { messages, status: 'done' };
    };
    if (call.name === 'write_file' && call.args?.path) {
      const path = String(call.args.path).trim();
      const now = await workspace.read(path).catch(() => null);
      const same = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();
      if (now !== null && wroteThisTurn.has(path) && same(now) === same(call.args.content)) return finishWith(`Done — ${path} is saved.`);
      // Rewriting the whole file a third time in one go is the same loop with small changes each time.
      if ((rewrites.get(path) || 0) >= 2) return finishWith(`Done — ${path} is saved (the model kept rewriting it, so Buddo kept the last version). Ask for a specific change if something's missing.`);
      rewrites.set(path, (rewrites.get(path) || 0) + 1);
    }
    if (repeats >= 1 && (call.name === 'write_file' || call.name === 'edit_file')) return finishWith(`Done — ${call.args?.path || 'the file'} is saved.`);
    // Loops that take turns ("todo, read src/app.js, sorry, todo, read src/app.js…") repeat a step without it being
    // the last one: count every step of this turn.
    const seenBefore = seen.get(sig) || 0;
    seen.set(sig, seenBefore + 1);
    if (seenBefore >= 2) repeats = 2;
    // The files are written and the model just goes round again (another todo list, another read): the work is done.
    const savedFiles = [...wroteThisTurn].filter(Boolean);
    if (savedFiles.length && (repeats >= 1 || (call.name === 'todo' && seenBefore >= 1))) {
      return finishWith(`Done — saved ${savedFiles.join(', ')}.`);
    }
    if (repeats >= 2) {
      onEvent({ type: 'tool-end', id: call.id, ok: false, output: 'Stopped: the same step three times in a row.' });
      onEvent({
        type: 'error',
        error: call.name === 'read_file' && missingReads
          ? `The model kept trying to read files that don't exist (${call.args?.path}) instead of writing code, so Buddo stopped it. Try asking again, or a bigger model.`
          : 'The model kept repeating the same step, so Buddo stopped it. Ask again in other words, or try a bigger model.',
      });
      return { messages, status: 'error' };
    }

    lastCallArgs = call.args;
    const result = await perform(call, tool);
    if (result?.ok && call.name === 'run_command') ranCommand = true;
    if (!result) {
      onEvent({ type: 'tool-end', id: call.id, ok: false, output: 'Stopped.' });
      onEvent({ type: 'stopped' });
      return { messages, status: 'stopped' };
    }

    let output = result.output;
    // Reading a file that isn't there (often one copied from an example): say plainly what to do instead.
    if (!result.ok && call.name === 'read_file' && /not found/i.test(result.output)) {
      missingReads++;
      const files = (await workspace.list('.', 2).catch(() => [])).filter((e) => e.type === 'file').map((e) => e.path);
      output = `${call.args?.path} does not exist. ${files.length ? `The files that exist are: ${files.slice(0, 30).join(', ')}.` : 'The project is empty: nothing has been written yet.'} Do not read files that don't exist and don't apologise.${files.length && !isNewBuild(askedText()) ? '' : ' Write the files for the request now, each one complete.'}`;
      if (missingReads >= 2 && wroteThisTurn.size) {
        onEvent({ type: 'tool-end', id: call.id, ok: false, output });
        const text = `Done — saved ${[...wroteThisTurn].join(', ')}.`;
        onEvent({ type: 'text', delta: text });
        messages.push({ role: 'assistant', content: text });
        onEvent({ type: 'done' });
        return { messages, status: 'done' };
      }
      if (missingReads >= 3) {
        onEvent({ type: 'tool-end', id: call.id, ok: false, output });
        onEvent({ type: 'error', error: `The model kept trying to read files that don't exist (${call.args?.path}) instead of writing code, so Buddo stopped it. Try asking again, or a bigger model.` });
        return { messages, status: 'error' };
      }
    }
    if (result.ok && (call.name === 'write_file' || call.name === 'edit_file')) {
      wroteThisTurn.add(String(call.args?.path || '').trim());
      if (lite) output = `${output.replace(/ Tip:.*$/, '')}\nSaved. Do NOT write ${call.args?.path} again. If something else is still missing, write only that; if everything asked for is done, reply with one short sentence and no code.`;
    }
    const images = result.images?.length ? result.images : undefined;
    if (images && !vision) output += '\n(Your current model can\'t see the attached image — use the text description above.)';
    if (savedFirst.length) output = `(Buddo saved the code blocks you wrote as files: ${savedFirst.join(', ')}. They exist now; don't write them again.)\n${output}`;
    messages.push({ role: 'user', content: `<tool_result name="${call.name}">\n${output}\n</tool_result>`, ...(images && vision ? { images } : {}) });
    onEvent({ type: 'tool-end', id: call.id, ok: result.ok, output: result.output, display: result.display, denied: result.denied });
  }

  onEvent({ type: 'error', error: `Stopped after ${maxSteps} steps. Say "continue" to keep going.` });
  return { messages, status: 'max-steps' };
}

/**
 * After a chat, ask the model (quietly, no tools) what new lasting facts it learned about the user.
 * Returns an array of short facts (possibly empty). contextBudget: pass the chat's own. Ollama reloads the whole
 * model whenever num_ctx changes, so a different size here made the user's next message wait for a reload.
 */
export async function learnAboutUser({ provider, model, profile, userTexts, signal, temperature = 0, contextBudget = 4096 }) {
  const text = userTexts.join('\n---\n').slice(-4000);
  if (text.replace(/\s/g, '').length < 25) return [];
  const known = normalizeProfile(profile).memories.map((m) => m.text);
  let out = '';
  for await (const chunk of provider.stream({ model, messages: [{ role: 'user', content: LEARN_PROMPT(known, text) }], signal, options: { temperature, num_ctx: contextBudget } })) {
    if (chunk.type === 'text') out += chunk.text;
    if (out.length > 2000) break;
  }
  return parseLearned(out.replace(/<think>[\s\S]*?<\/think>/g, ''));
}
