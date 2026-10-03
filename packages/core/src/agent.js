// The agent loop: stream model output → detect a tool call → (ask permission) →
// execute → feed the result back → repeat until the model answers without tools.

import { analyze, splitThinking } from './parser.js';
import { executeTool, TOOL_MAP } from './tools.js';
import { buildSystemPrompt } from './prompt.js';
import { formatTree } from './tree.js';
import { LEARN_PROMPT, parseLearned, normalizeProfile } from './personality.js';
import { extractCodeFiles, asksForCode, isRefusal, fenceRawHtml } from './codeblocks.js';
import { planCodeSave, looksLikeEdit, isNewBuild, parseFindReplace, linkedFiles, asksToRemove, rewriteAsEdits } from './edits.js';

export const estimateTokens = (s) => Math.ceil((s || '').length / 3.6);

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
  // What the user typed, without the file Buddo attached for small models.
  const askedText = () => lastUserText().split('\n\n[Current ')[0];

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

  // Small models can't open files themselves: for an edit request, show them the current page.
  if (lite && autoSaveCode && mode !== 'plan' && workspace.write) {
    const msg = lastUserMsg();
    if (msg && msg === messages[messages.length - 1] && looksLikeEdit(msg.content) && !msg.content.includes('<file path=')) {
      const shown = await editFilesToShow();
      if (shown.length && shown[0].content.length < 7000) {
        msg.content += `\n\n${showFiles(shown)}\n${askEdit(shown.map((f) => f.path))}`;
        onEvent({ type: 'nudge', text: `Showed the model the current ${shown.map((f) => f.path).join(', ')} to edit` });
      }
    }
  }

  /** Ask permission if needed, then run the tool. Returns the result, or null if the user stopped. */
  const perform = async (call, tool) => {
    if (tool && mode === 'plan' && (tool.kind === 'write' || tool.kind === 'exec')) {
      return { ok: false, output: 'Blocked: plan mode is read-only. Finish investigating and present your plan instead.' };
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
    if (result.ok && (call.name === 'write_file' || call.name === 'edit_file')) wroteFiles = true;
    if (result.ok && call.name === 'write_file' && result.display?.created) createdHere.add(String(call.args.path).trim());
    return result;
  };
  let lastSig = '';
  let repeats = 0;
  let incomplete = 0;
  let id = 0;

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

    const wire = [{ role: 'system', content: system }, ...compactForModel(messages, contextBudget)].map((m) =>
      vision || !m.images ? m : { role: m.role, content: m.content },
    );
    // Tell UIs what the model is reading right now (before the first token, it is "reading the prompt").
    const prev = messages[messages.length - 1];
    const after = prev?.role === 'user' && prev.content.startsWith('<tool_result') ? /name="([^"]+)"/.exec(prev.content)?.[1] : null;
    onEvent({ type: 'step', step, promptTokens: contextTokens(wire), after });

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
            ? `Write the change now.\n\n${showFiles(shown)}\n${askEdit(shown.map((f) => f.path))}`
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
        if (failed.length) onEvent({ type: 'error', error: failed[0] });
        onEvent({ type: 'done' });
        return { messages, status: saved.length ? 'done' : 'error' };
      }

      // The model answered with plain code blocks instead of tool calls → save them as files.
      if (canSave) {
        const files = extractCodeFiles(text || a.thinking, { wantsCode }).filter((f) => wantsCode || !f.inferred);
        const editFiles = files.length ? await readEditFiles() : [];
        const [target, ...related] = editFiles;
        const { writes, needFull } = await planCodeSave(files, {
          target,
          related,
          edit: !!target && !isNewBuild(askedText()),
          removing: asksToRemove(askedText()),
          read: (p) => workspace.read(p),
        });
        // Buddo couldn't tell where the lines go (or the model left parts out): ask again for just the
        // changed lines with a line of context; only as a last resort for the whole file (still saved as line edits).
        if (needFull && !writes.length && target && nudges < MAX_NUDGES) {
          nudges++;
          const shown = editFiles.filter((f) => f.content.length < 9000);
          messages.push({
            role: 'user',
            content:
              nudges === 1
                ? `I couldn't tell where those lines go. Write them again with one unchanged line above and below each change, under the file name. Never leave parts out with "..." comments.\n\n${showFiles(shown)}\n${askEdit(shown.map((f) => f.path))}`
                : `Please write the COMPLETE updated ${target.path} (the whole file, nothing left out) in one code block.\n\n${showFiles([target])}`,
          });
          onEvent({ type: 'nudge', text: nudges === 1 ? `Couldn't place the model's lines in ${target.path} — asked it to show where they go` : `Asked the model for the whole ${target.path}` });
          continue;
        }
        const saved = [];
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
            if (denied) continue;
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
          onEvent({ type: 'tool-end', id: call.id, ok: result.ok, output: result.output, display: result.display, denied: result.denied });
        }
        if (saved.length) messages[messages.length - 1].content += `\n\n[Buddo saved these code blocks as files: ${saved.join(', ')}]`;
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
