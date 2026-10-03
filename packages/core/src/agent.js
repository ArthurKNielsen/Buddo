// The agent loop: stream model output → detect a tool call → (ask permission) →
// execute → feed the result back → repeat until the model answers without tools.

import { analyze, splitThinking } from './parser.js';
import { executeTool, TOOL_MAP } from './tools.js';
import { buildSystemPrompt } from './prompt.js';
import { formatTree } from './tree.js';
import { LEARN_PROMPT, parseLearned, normalizeProfile } from './personality.js';
import { extractCodeFiles, asksForCode, isRefusal } from './codeblocks.js';

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
  let nudged = false;
  const lastUserText = () => [...messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith('<tool_result'))?.content || '';

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
    const result = await executeTool(call, {
      workspace,
      onChange: callbacks.onChange,
      onTodos: callbacks.onTodos,
      onRemember: normalizeProfile(profile).learn ? callbacks.onRemember : undefined,
      onCommand: callbacks.onCommand,
      onCommandData: callbacks.onCommandData,
    });
    if (result.ok && (call.name === 'write_file' || call.name === 'edit_file')) wroteFiles = true;
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
      for await (const chunk of provider.stream({ model, messages: wire, signal: ctrl.signal, options: { num_ctx: contextBudget, temperature } })) {
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
        onEvent({ type: 'error', error: 'The model returned an empty response. Try again or pick a bigger model.' });
        return { messages, status: 'error' };
      }
      const wantsCode = asksForCode(lastUserText());

      // Small models sometimes claim they "can't create files". Remind them once that Buddo saves files.
      if (autoSaveCode && !wroteFiles && !nudged && wantsCode && mode !== 'plan' && isRefusal(text) && !/```/.test(text)) {
        nudged = true;
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: 'You CAN do this — Buddo saves files for you automatically. Write the complete code now: put each file name on its own line, then the full code in a fenced code block.',
        });
        onEvent({ type: 'nudge', text: 'Reminded the model that it can write files' });
        continue;
      }

      messages.push({ role: 'assistant', content: text || a.thinking.trim() });
      if (!text && a.thinking) onEvent({ type: 'text', delta: a.thinking.trim() });

      // The model answered with plain code blocks instead of tool calls → save them as files.
      if (autoSaveCode && !wroteFiles && mode !== 'plan' && workspace.write) {
        const files = extractCodeFiles(text || a.thinking).filter((f) => wantsCode || !f.inferred);
        const saved = [];
        for (const f of files.slice(0, 12)) {
          const call = { id: `t${Date.now().toString(36)}${id++}`, name: 'write_file', args: { path: f.path, content: f.content }, auto: true };
          onEvent({ type: 'tool-start', call, kind: 'write', auto: true });
          const result = await perform(call, TOOL_MAP.write_file);
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
