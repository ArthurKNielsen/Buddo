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
