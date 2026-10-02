// The agent loop: stream model output → detect a tool call → (ask permission) →
// execute → feed the result back → repeat until the model answers without tools.

import { analyze, splitThinking } from './parser.js';
import { executeTool, TOOL_MAP } from './tools.js';
import { buildSystemPrompt } from './prompt.js';
import { formatTree } from './tree.js';

export const estimateTokens = (s) => Math.ceil((s || '').length / 3.6);

export function contextTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}

/** Shrink old tool results when the conversation gets close to the context budget. */
export function compactForModel(messages, budget) {
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
}) {
  const ctx = context || (await gatherContext(workspace));
  const system = buildSystemPrompt({ workspace, mode, ...ctx });
  const alwaysAllowed = new Set();
  let lastSig = '';
  let repeats = 0;
  let incomplete = 0;
  let id = 0;

  for (let step = 0; step < maxSteps; step++) {
    onEvent({ type: 'step', step });
    const ctrl = linkSignal(signal);
    let raw = '';
    let sentProse = 0;
    let sentThink = 0;
    let nativeThinking = '';
    let usage = null;
    let stopForTool = false;
    let announced = false;

    const wire = [{ role: 'system', content: system }, ...compactForModel(messages, contextBudget)];

    try {
      for await (const chunk of provider.stream({ model, messages: wire, signal: ctrl.signal, options: { num_ctx: contextBudget, temperature } })) {
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
      messages.push({ role: 'assistant', content: text || a.thinking.trim() });
      if (!text && a.thinking) onEvent({ type: 'text', delta: a.thinking.trim() });
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

    let result;
    if (tool && mode === 'plan' && (tool.kind === 'write' || tool.kind === 'exec')) {
      result = { ok: false, output: 'Blocked: plan mode is read-only. Finish investigating and present your plan instead.' };
    } else if (tool && NEEDS_PERMISSION[mode]?.has(tool.kind) && !alwaysAllowed.has(call.name)) {
      onEvent({ type: 'permission', call });
      const answer = await askPermission(call);
      if (signal?.aborted) {
        onEvent({ type: 'tool-end', id: call.id, ok: false, output: 'Stopped.' });
        onEvent({ type: 'stopped' });
        return { messages, status: 'stopped' };
      }
      if (answer === 'always') alwaysAllowed.add(call.name);
      if (answer === 'deny') {
        result = { ok: false, output: 'The user denied this action. Ask what they would like instead, or try a different approach.', denied: true };
      }
    }

    if (!result) {
      result = await executeTool(call, {
        workspace,
        onChange: callbacks.onChange,
        onTodos: callbacks.onTodos,
        onCommand: callbacks.onCommand,
        onCommandData: callbacks.onCommandData,
      });
    }

    let output = result.output;
    if (repeats >= 2) output += '\n\nNote: you have made this exact call several times. Do something different or finish.';
    messages.push({ role: 'user', content: `<tool_result name="${call.name}">\n${output}\n</tool_result>` });
    onEvent({ type: 'tool-end', id: call.id, ok: result.ok, output: result.output, display: result.display, denied: result.denied });
  }

  onEvent({ type: 'error', error: `Stopped after ${maxSteps} steps. Say "continue" to keep going.` });
  return { messages, status: 'max-steps' };
}
