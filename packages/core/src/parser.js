// Streaming-friendly parser for the text tool protocol and <think> blocks.

import { TOOL_MAP, BIG_PARAMS } from './tools.js';

const OPEN_RE = /<tool:([a-z_]+)\s*>/;

function trimBlock(v) {
  return v.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

function stripFence(v, param, path = '') {
  if (param !== 'content' || /\.(md|mdx|markdown)$/i.test(path)) return v;
  const m = /^```[\w+-]*\n([\s\S]*?)\n```\s*$/.exec(v);
  return m ? m[1] : v;
}

export function parseArgs(name, body) {
  const tool = TOOL_MAP[name];
  const params = tool ? tool.params : [...body.matchAll(/<([a-z_]+)>/g)].map((x) => x[1]);
  const args = {};
  for (const p of params) {
    const open = `<${p}>`;
    const close = `</${p}>`;
    const i = body.indexOf(open);
    if (i === -1) continue;
    let j;
    if (p === 'content' || p === 'new' || p === 'items') j = body.lastIndexOf(close);
    else j = body.indexOf(close, i + open.length);
    if (j === -1 || j < i) {
      // Unclosed param: take the rest of the body (models sometimes forget the last close tag).
      j = body.length;
    }
    let v = body.slice(i + open.length, j);
    v = BIG_PARAMS.has(p) ? trimBlock(v) : v.trim();
    args[p] = v;
  }
  if (args.content !== undefined) args.content = stripFence(args.content, 'content', args.path);
  return args;
}

// Fallback for models that emit their native JSON format: <tool_call>{"name":…,"arguments":{…}}</tool_call>
function findJsonToolCall(text) {
  const s = text.indexOf('<tool_call>');
  if (s === -1) return null;
  const e = text.indexOf('</tool_call>', s);
  if (e === -1) return { name: 'tool_call', complete: false, start: s };
  let name = 'invalid_json';
  let args = {};
  try {
    const j = JSON.parse(text.slice(s + 11, e).trim());
    name = j.name || j.function?.name || name;
    const raw = j.arguments ?? j.parameters ?? j.function?.arguments ?? {};
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (const [k, v] of Object.entries(obj)) args[k] = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {}
  return { name, complete: true, start: s, end: e + 12, args };
}

/** Find the first tool call in `text`. */
export function findToolCall(text) {
  const m = OPEN_RE.exec(text);
  const json = findJsonToolCall(text);
  if (json && (!m || json.start < m.index)) return json;
  if (!m) return null;
  const name = m[1];
  const close = `</tool:${name}>`;
  const bodyStart = m.index + m[0].length;
  const end = text.indexOf(close, bodyStart);
  if (end === -1) return { name, complete: false, start: m.index };
  return {
    name,
    complete: true,
    start: m.index,
    end: end + close.length,
    args: parseArgs(name, text.slice(bodyStart, end)),
  };
}

/** Split raw model output into thinking text and visible text. */
export function splitThinking(raw) {
  let thinking = '';
  let visible = '';
  let rest = raw;
  // Some models start directly inside a think block without the opening tag.
  if (!rest.includes('<think>') && rest.includes('</think>')) rest = '<think>' + rest;
  while (rest.length) {
    const s = rest.indexOf('<think>');
    if (s === -1) {
      visible += rest;
      break;
    }
    visible += rest.slice(0, s);
    const e = rest.indexOf('</think>', s);
    if (e === -1) {
      thinking += rest.slice(s + 7);
      break;
    }
    thinking += rest.slice(s + 7, e);
    rest = rest.slice(e + 8);
  }
  return { thinking: thinking.trim() ? thinking : '', visible };
}

/**
 * Analyze buffered model output. Returns the visible prose before any tool call,
 * thinking text, and the tool call (if any). `safe` is the part of visible text
 * that can be streamed without risking a half-written tag.
 */
export function analyze(raw) {
  const { thinking, visible } = splitThinking(raw);
  const call = findToolCall(visible);
  let prose = call ? visible.slice(0, call.start) : visible;
  if (call) prose = prose.replace(/```[\w-]*\s*$/, '');
  let safe = prose;
  if (!call) {
    const lt = safe.lastIndexOf('<');
    // Hold back anything that could still become a tag (<tool:run_command>, <think>, <tool_call>…).
    if (lt !== -1 && /^<[a-z_:]{0,40}$/i.test(safe.slice(lt))) safe = safe.slice(0, lt);
    // Hold back a trailing fence that may be opening a tool block.
    safe = safe.replace(/```[\w-]*\s*$/, '');
  }
  return { thinking, prose, safe, call };
}
