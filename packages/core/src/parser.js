// Streaming-friendly parser for the text tool protocol and <think> blocks.

import { TOOL_MAP, BIG_PARAMS } from './tools.js';

// Tiny models often drop the "tool:" prefix (<write_file>…</write_file>); accept that for known tools.
const OPEN_RE = new RegExp(`<(tool:)?([a-z_]+)\\s*>`, 'g');
// A bare tag only counts when a parameter follows (so HTML like <search> in code is left alone).
function bareCall(name, after) {
  const tool = TOOL_MAP[name];
  if (!tool || tool.params.includes(name)) return false;
  const next = after.trimStart();
  return !next || tool.params.some((p) => next.startsWith(`<${p}>`) || `<${p}>`.startsWith(next));
}
function findOpen(text) {
  OPEN_RE.lastIndex = 0;
  for (let m; (m = OPEN_RE.exec(text)); ) {
    if (m[1] || bareCall(m[2], text.slice(m.index + m[0].length))) return { index: m.index, length: m[0].length, name: m[2], prefix: m[1] || '' };
  }
  return null;
}

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

/**
 * Best-effort args of a tool call that is still streaming in, so UIs can show the code as it's written.
 * Drops a half-written closing tag at the very end (e.g. "</cont").
 */
export function parsePartial(name, body) {
  const cleaned = body.replace(/<\/?[a-z_:]*$/i, '');
  const args = parseArgs(name, cleaned);
  const open = [...cleaned.matchAll(/<([a-z_]+)>/g)].map((x) => x[1]);
  const writing = open.filter((p) => !cleaned.includes(`</${p}>`)).pop();
  return { args, writing };
}

// Llama 3.x's native tool format: a reply that is just {"name": "write_file", "parameters": {...}} (maybe fenced as json).
const BARE_JSON = /^\s*(?:<\|python_tag\|>)?\s*(?:```(?:json)?\s*)?(\{[\s\S]*\})\s*(?:```)?\s*$/;
function findBareJsonCall(text) {
  const m = BARE_JSON.exec(text);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    const name = j.name || j.function?.name;
    if (!TOOL_MAP[name]) return null;
    const raw = j.parameters ?? j.arguments ?? j.function?.arguments ?? {};
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const args = {};
    for (const [k, v] of Object.entries(obj)) args[k] = typeof v === 'string' ? v : JSON.stringify(v);
    return { name, complete: true, start: text.indexOf(m[1]) - (text.slice(0, text.indexOf(m[1])).match(/```(?:json)?\s*$/)?.[0].length || 0), end: text.length, args };
  } catch {
    return null;
  }
}

/** Find the first tool call in `text`. */
export function findToolCall(text) {
  const m = findOpen(text);
  const json = findJsonToolCall(text);
  if (json && (!m || json.start < m.index)) return json;
  if (!m) return findBareJsonCall(text);
  const name = m.name;
  const close = `</${m.prefix}${name}>`;
  const bodyStart = m.index + m.length;
  const end = text.indexOf(close, bodyStart);
  if (end === -1) return { name, complete: false, start: m.index, partial: parsePartial(name, text.slice(bodyStart)) };
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
      // Small models sometimes forget </think>: a tool call inside still counts as an action.
      const inner = rest.slice(s + 7);
      const t = inner.search(/<tool:[a-z_]+\s*>|<tool_call>/);
      if (t !== -1) {
        thinking += inner.slice(0, t);
        visible += inner.slice(t);
        // Hold back a half-written closing tag ("</thi") so it never shows up in streamed thoughts.
      } else thinking += inner.replace(/<\/?[a-z_:]{0,10}$/i, '');
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
    // A reply that starts like a JSON tool call ({"name": …) is held back until we know what it is.
    if (/^\s*(?:<\|python_tag\|>)?\s*(?:```(?:json)?\s*)?\{\s*("|$)/.test(visible) && !/\n\s*\n/.test(visible.trim())) safe = '';
  }
  return { thinking, prose, safe, call };
}
