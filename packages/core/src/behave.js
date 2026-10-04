// Keeping a small model honest and on task: tool calls in every format it might use, a forced tool call when it
// only promises to act, and no repeating itself.

import { BIG_PARAMS } from './tools.js';

/** A tool call (from built-in tool calling or a forced JSON reply) in Buddo's text protocol, for the parser. */
export function toolCallText(name, args = {}) {
  const body = Object.entries(args)
    .map(([k, v]) => (BIG_PARAMS.has(k) ? `<${k}>\n${v}\n</${k}>` : `<${k}>${v}</${k}>`))
    .join('\n');
  return `<tool:${name}>\n${body}\n</tool:${name}>`;
}

/**
 * The JSON shape a reply must have when Buddo forces a tool call (Ollama's `format`): the model can't answer in
 * words, only by naming a tool and its arguments.
 */
export function forcedCallSchema(tools) {
  const params = [...new Set(tools.flatMap((t) => t.params))];
  return {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: tools.map((t) => t.name) },
      args: { type: 'object', properties: Object.fromEntries(params.map((p) => [p, { type: 'string' }])) },
    },
    required: ['tool', 'args'],
  };
}

/** The tool call in a forced JSON reply ({"tool": "write_file", "args": {…}}), or null. */
export function parseForcedCall(raw = '', names = []) {
  const at = raw.indexOf('{');
  if (at === -1) return null;
  try {
    const j = JSON.parse(raw.slice(at, raw.lastIndexOf('}') + 1));
    const name = j.tool || j.name;
    if (!names.includes(name)) return null;
    const args = Object.fromEntries(Object.entries(j.args || j.arguments || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    return { name, args };
  } catch {
    return null;
  }
}

// "I'll create main.py now.", "Let me read the file:", "Next, I will update styles.css" — and then nothing happens.
const PROMISE = /\b(?:i['’]ll|i will|let me|let['’]s|i['’]m going to|i am going to|i['’]m gonna|now i(?:['’]ll| will)|next,? i(?:['’]ll| will))\s+(?:now\s+|first\s+|quickly\s+|go ahead and\s+)?(?:create|write|make|add|update|edit|change|fix|modify|read|open|check|look at|inspect|run|test|search|build|implement|save|remove|delete|rename|install)\b/i;
/** Does the end of a reply promise an action it never took? */
export const promisesAction = (text = '') => PROMISE.test(outsideCode(text).slice(-400));

/** The text with fenced code blocks taken out (repeated lines in code are normal). */
function outsideCode(text) {
  return text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2[ \t]*(?=\n|$)|$)/g, '\n');
}

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Where a reply starts going round in circles, or -1. A line or sentence of prose said for the third time
 * (or a long one for the second time in a row) is a loop: the reply is cut there.
 */
export function findLoop(text = '') {
  let inCode = false;
  const seen = new Map();
  let prev = '';
  let pos = 0;
  for (const line of text.split('\n')) {
    const start = pos;
    pos += line.length + 1;
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const k = norm(line);
    if (k.length < 12) continue;
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n >= 3 || (n === 2 && k === prev && k.length >= 40)) return start;
    prev = k;
    // The same sentence over and over on one line.
    const m = /([^.!?\n]{20,}?[.!?])(\s*\1){2,}/.exec(line);
    if (m) return start + m.index + m[1].length;
  }
  return -1;
}

/** The reply without paragraphs it already said (outside code), and without trailing copies. */
export function dropRepeats(text = '') {
  const seen = new Set();
  let inCode = false;
  const out = [];
  for (const para of text.split(/\n{2,}/)) {
    const fences = (para.match(/^\s*(`{3,}|~{3,})/gm) || []).length;
    const k = norm(para);
    const prose = !inCode && !fences;
    if (fences % 2) inCode = !inCode;
    if (prose && k.length >= 20 && seen.has(k)) continue;
    if (prose) seen.add(k);
    out.push(para);
  }
  return out.join('\n\n');
}

/** Is this answer (nearly) the same as an earlier one? Word overlap, so small wording changes still count. */
export function sameAnswer(a = '', b = '') {
  const wa = norm(outsideCode(a)).split(' ').filter((w) => w.length > 2);
  const wb = new Set(norm(outsideCode(b)).split(' ').filter((w) => w.length > 2));
  if (wa.length < 8 || !wb.size) return false;
  const hit = wa.filter((w) => wb.has(w)).length;
  return hit / wa.length > 0.85 && Math.min(wa.length, wb.size) / Math.max(wa.length, wb.size) > 0.7;
}

/** A few-shot example of the text tool protocol, for models without built-in tool calling (they copy patterns). */
export const PROTOCOL_EXAMPLE = [
  { role: 'user', content: '(Example of how tools work. Not the user\'s project, never copy it.) Make notes.txt that says "todo: water plants".' },
  { role: 'assistant', content: '<tool:write_file>\n<path>notes.txt</path>\n<content>\ntodo: water plants\n</content>\n</tool:write_file>' },
  { role: 'user', content: '<tool_result name="write_file">\nCreated notes.txt (1 line).\n</tool_result>' },
  { role: 'assistant', content: 'Created notes.txt.' },
];

// ── Strict replies ──
// With constrained decoding (Ollama's `format`) every reply is ONE JSON object of this shape, token by token: the
// model can't answer in a way that skips the tools. {"think"?, "say", "tool", "args"}: `say` is what the user
// reads, `tool` the tool to call, or "done" when the work is finished.

/**
 * The shape of one strict reply. allowDone false: "done" isn't one of the choices, so the model has to call a
 * tool (a build request before anything was written).
 */
export function strictReplySchema(tools, { allowDone = true, think = false } = {}) {
  const params = [...new Set(tools.flatMap((t) => t.params))];
  const names = tools.map((t) => t.name);
  return {
    type: 'object',
    properties: {
      ...(think ? { think: { type: 'string' } } : {}),
      say: { type: 'string' },
      tool: { type: 'string', enum: allowDone ? [...names, 'done'] : names },
      args: { type: 'object', properties: Object.fromEntries(params.map((p) => [p, { type: 'string' }])) },
    },
    required: [...(think ? ['think'] : []), 'say', 'tool', 'args'],
  };
}

/**
 * A JSON string value that may still be streaming in: {value, done}, or null before its key shows up.
 * `from`: where to start looking (the "args" object, so a "say" inside code isn't mistaken for the reply's).
 */
export function partialJsonString(raw = '', key, from = 0) {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(raw.slice(from));
  if (!m) return null;
  let i = from + m.index + m[0].length;
  let out = '';
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') return { value: out, done: true };
    if (c === '\\') {
      const n = raw[i + 1];
      if (n === undefined) break;
      if (n === 'u') {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[n] ?? n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return { value: out, done: false };
}

/** What a streaming strict reply says so far: { think, say, tool, args (path/content so far), argsAt }. */
export function readStrictReply(raw = '') {
  const argsAt = raw.search(/"args"\s*:/);
  const head = argsAt === -1 ? raw : raw.slice(0, argsAt);
  const args = {};
  if (argsAt !== -1) for (const k of ['path', 'content', 'command', 'old', 'new']) {
    const v = partialJsonString(raw, k, argsAt);
    if (v) args[k] = v.value;
  }
  return {
    think: partialJsonString(head, 'think')?.value || '',
    say: partialJsonString(head, 'say')?.value || '',
    tool: partialJsonString(head, 'tool')?.value || '',
    args,
    argsAt,
  };
}

/** The finished strict reply, or null when it isn't valid JSON (cut off). */
export function parseStrictReply(raw = '') {
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const args = Object.fromEntries(Object.entries(j.args || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    return { think: String(j.think || ''), say: String(j.say || ''), tool: String(j.tool || 'done'), args };
  } catch {
    return null;
  }
}
