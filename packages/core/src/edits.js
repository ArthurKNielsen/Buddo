// Turning a small model's code reply into the right file change.
// Tiny models answer edit requests with fragments ("change this CSS rule", "add this to your script")
// instead of whole files. Saving a fragment as a new file does nothing to the page, so:
//  - CSS fragments are merged into the page's stylesheet (rule by rule),
//  - a full HTML page replaces the page being edited,
//  - other fragments ask the model once for the complete file.

/** Guess the language of an unlabeled code block. */
export function sniffLang(code = '') {
  const t = code.trim();
  if (/^<!doctype html|^<html[\s>]|^<(head|body|div|section|main|h[1-6]|p|button|ul|form|canvas|style|script)[\s>]/i.test(t)) return 'html';
  if (/^(def |class \w+[:(]|import \w+$|from \w+ import |print\()/m.test(t) && !/[{};]\s*$/m.test(t.split('\n')[0])) return 'py';
  if (/^[\w.#:\-\s,>*[\]="'()]+\{[^{}]*:[^{}]*\}/m.test(t) && !/\b(function|const|let|var|=>|return)\b/.test(t)) return 'css';
  if (/\b(function|const|let|var|document\.|window\.|console\.|addEventListener|=>)\b/.test(t)) return 'js';
  return '';
}

export const isFullHtml = (s = '') => /<!doctype html|<html[\s>]/i.test(s) && /<\/html>|<body/i.test(s);

// ── CSS merging ──
function parseRules(css) {
  // Top-level rules only: [{ selector, body, start, end }] (at-rules kept whole, keyed by their prelude).
  const rules = [];
  let i = 0;
  const s = css;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open === -1) break;
    const selector = s.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1;
    let j = open + 1;
    for (; j < s.length && depth; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') depth--;
    }
    rules.push({ selector, body: s.slice(open + 1, j - 1), start: i, end: j });
    i = j;
  }
  return rules;
}
const normSel = (sel) => sel.replace(/\s+/g, ' ').replace(/\s*([,>+~])\s*/g, '$1').trim().toLowerCase();
function parseDecls(body) {
  const out = new Map();
  for (const d of body.split(';')) {
    const k = d.indexOf(':');
    if (k === -1) continue;
    const prop = d.slice(0, k).trim().toLowerCase();
    if (prop) out.set(prop, d.slice(k + 1).trim());
  }
  return out;
}

/** Merge a CSS fragment into a stylesheet: same selector → its properties are updated, new selectors are appended. */
export function mergeCss(base = '', fragment = '') {
  const baseRules = parseRules(base);
  let out = base;
  const appended = [];
  // Replace from the end so earlier offsets stay valid.
  const edits = [];
  for (const r of parseRules(fragment)) {
    const match = r.selector.startsWith('@') ? null : [...baseRules].reverse().find((b) => normSel(b.selector) === normSel(r.selector));
    if (!match) {
      appended.push(`${r.selector} {${r.body}}`);
      continue;
    }
    const decls = parseDecls(match.body);
    for (const [k, v] of parseDecls(r.body)) decls.set(k, v);
    const indent = /\n(\s+)\S/.exec(match.body)?.[1] ?? '  ';
    const body = `\n${[...decls].map(([k, v]) => `${indent}${k}: ${v};`).join('\n')}\n`;
    edits.push({ start: match.start, end: match.end, text: `${base.slice(match.start, match.start + (base.slice(match.start).indexOf('{')))}{${body}}` });
  }
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (appended.length) out = `${out.replace(/\s*$/, '')}\n\n${appended.join('\n\n')}\n`;
  return out;
}

/** Put CSS into an HTML page: merged into its last <style>, or a new <style> in <head>. */
export function mergeCssIntoHtml(html = '', css = '') {
  const re = /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi;
  let last = null;
  for (const m of html.matchAll(re)) last = m;
  if (last) {
    const merged = mergeCss(last[2], css);
    const at = last.index;
    return html.slice(0, at) + last[1] + (merged.startsWith('\n') ? '' : '\n') + merged.replace(/\s*$/, '\n') + last[3] + html.slice(at + last[0].length);
  }
  const block = `<style>\n${css.trim()}\n</style>\n`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${block}</head>`);
  return block + html;
}

const NEW_THING = /\b(make|create|build|write|generate|code|design|program|develop|want|need|give)\s+(me\s+|us\s+)?(a|an|another|new|some)\b/i;
const EDIT_WORDS =
  /\b(change|move|add|remove|delete|fix|update|edit|rename|replace|turn|increase|decrease|bigger|smaller|larger|wider|taller|center|centre|align|colou?r|darker|lighter|background|font|style|swap|instead|improve|modify|put|resize|round(ed)?|bold|hide|show|make (it|the|this|that|them|everything|all|my))\b/i;

/** Does this message ask for something new ("make me a snake game")? */
export const isNewBuild = (text = '') => NEW_THING.test(text);

/** Does this message ask to change existing code (rather than build something new)? */
export const looksLikeEdit = (text = '') => !NEW_THING.test(text) && EDIT_WORDS.test(text);

/**
 * Decide what to do with the code files found in a reply.
 * files: from extractCodeFiles. target: { path, content } of the page being worked on (or null).
 * Returns { writes: [{ path, content, merged? }], needFull: boolean }.
 */
export async function planCodeSave(files, { target, edit = false, read = async () => null } = {}) {
  const writes = [];
  let needFull = false;
  for (const f of files) {
    // A complete page: replace the page being edited (keeps its name), or save as named.
    if (f.lang === 'html' && isFullHtml(f.content)) {
      writes.push({ ...f, path: f.inferred && target && /\.html?$/i.test(target.path) ? target.path : f.path });
      continue;
    }
    const existing = await read(f.path).catch(() => null);
    const fragmentOfTarget = edit && target && f.inferred;
    if (f.lang === 'css' && (fragmentOfTarget || (existing && f.content.length < existing.length * 0.6))) {
      // Merge into the stylesheet the page links, else into the page's own <style>.
      const linked = target && /<link[^>]+href=["']([^"':]+\.css)["']/i.exec(target.content)?.[1];
      const sheet = linked ? await read(linked).catch(() => null) : null;
      if (existing && !linked) writes.push({ ...f, content: mergeCss(existing, f.content), merged: true });
      else if (sheet !== null && linked) writes.push({ ...f, path: linked, content: mergeCss(sheet, f.content), merged: true });
      else if (target) writes.push({ ...f, path: target.path, lang: 'html', content: mergeCssIntoHtml(target.content, f.content), merged: true });
      continue;
    }
    // A snippet of an existing page/script: splice the changed lines in where they clearly belong,
    // else ask for the whole file.
    if (fragmentOfTarget || (existing && existing.split('\n').length > 8 && f.content.length < existing.length * 0.5)) {
      const base = existing !== null && !fragmentOfTarget ? { path: f.path, content: existing } : target;
      const m = base && mergeChangedLines(base.content, f.content);
      if (m) writes.push({ ...f, path: base.path, content: m.content, merged: true, edit: { old: m.old, new: m.new } });
      else needFull = true;
      continue;
    }
    writes.push(f);
  }
  return { writes, needFull };
}

// ── Find/replace edits ──
// Rewriting a whole file to change one line is the slowest thing a tiny model can do (on a CPU, every token
// counts). So small models may answer with just the change:
//   index.html
//   <<<<<<< SEARCH
//   background: white;
//   =======
//   background: blue;
//   >>>>>>> REPLACE
const FR_START = /^\s*<{5,9}\s*(?:SEARCH|FIND|ORIGINAL)?\s*$/i;
const FR_SPLIT = /^\s*={5,9}\s*$/;
const FR_END = /^\s*>{5,9}\s*(?:REPLACE|UPDATED)?\s*$/i;
const FR_FILE = /((?:[\w-]+\/)*[\w.-]+\.(?:html?|css|s[ac]ss|less|m?jsx?|tsx?|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|lua|dart|json|ya?ml|toml|sql|md|xml|svg|txt|sh))\b/i;

/** Find/replace blocks in a reply: [{ path (or null), find, replace }]. */
export function parseFindReplace(text = '') {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FR_START.test(lines[i])) continue;
    // The file name: the closest line above that names a file (skipping blank lines and ``` fences).
    let path = null;
    for (let k = i - 1, seen = 0; k >= 0 && seen < 3; k--) {
      const l = lines[k].trim();
      if (!l || /^(`{3,}|~{3,})[\w+#.-]*$/.test(l)) continue;
      seen++;
      if (FR_END.test(l)) break;
      path = FR_FILE.exec(l)?.[1] || null;
      if (path) break;
    }
    const find = [];
    const replace = [];
    let j = i + 1;
    for (; j < lines.length && !FR_SPLIT.test(lines[j]); j++) find.push(lines[j]);
    if (j >= lines.length) break; // no ======= : not an edit
    for (j++; j < lines.length && !FR_END.test(lines[j]) && !FR_START.test(lines[j]); j++) replace.push(lines[j]);
    // Tiny models sometimes forget >>>>>>> REPLACE at the very end: drop a trailing code fence instead.
    if (j >= lines.length) while (replace.length && /^\s*(`{3,}|~{3,})\s*$|^\s*$/.test(replace[replace.length - 1])) replace.pop();
    out.push({ path: path?.replace(/^\.?\//, '') || null, find: find.join('\n'), replace: replace.join('\n') });
    i = FR_START.test(lines[j] || '') ? j - 1 : j;
  }
  return out;
}

// ── Changed-lines edits ──
// The easiest edit for a tiny model: "write only the lines you change". It answers with e.g.
// `<button>Go</button>`, and Buddo finds the line it replaces (`<button>Send</button>`) by similarity.
// Lines that match nothing are new: they go after the matched line above them.

function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
const normLine = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const wordsOf = (s) => new Set(s.match(/[a-z0-9]{3,}/g) || []);
const tagOf = (s) => /^<([a-z][\w-]*)/.exec(s)?.[1] || '';

/**
 * Splice a snippet of changed lines into a file. Returns { content, old, new } (old/new: the replaced
 * block of lines and its replacement), or null when it can't tell safely where the lines go.
 */
export function mergeChangedLines(content = '', snippet = '') {
  const file = content.replace(/\n$/, '').split('\n');
  const snip = snippet.split('\n').filter((l) => l.trim());
  if (!snip.length || snip.length > 40 || snip.length >= file.length * 0.8) return null;
  const keys = file.map(normLine);
  // Hints for lines whose text changed a lot: a word only that line has ("pug"), or a tag only it has (<h1>).
  const words = keys.map(wordsOf);
  const wordCount = new Map();
  words.forEach((w, i) => w.forEach((x) => wordCount.set(`${tagOf(keys[i])} ${x}`, (wordCount.get(`${tagOf(keys[i])} ${x}`) || 0) + 1)));
  const tagCount = new Map();
  for (const k of keys) if (tagOf(k)) tagCount.set(tagOf(k), (tagCount.get(tagOf(k)) || 0) + 1);
  const hint = (k, i) => {
    let bonus = 0;
    // (unique among lines with the same tag: "pug" is in one <p>, even if an <h2> says Pug too)
    if (tagOf(k) === tagOf(keys[i])) for (const x of wordsOf(k)) if (wordCount.get(`${tagOf(k)} ${x}`) === 1 && words[i].has(x)) bonus = 0.3;
    if (tagOf(k) && tagOf(k) === tagOf(keys[i]) && tagCount.get(tagOf(k)) === 1) bonus = 0.3;
    return bonus;
  };
  const map = [];
  let last = -1;
  for (const line of snip) {
    const k = normLine(line);
    let best = -1;
    let score = 0;
    let second = 0;
    for (let i = last + 1; i < file.length; i++) {
      const s = similarity(k, keys[i]) + hint(k, i);
      if (s > score) [second, score, best] = [score, s, i];
      else if (s > second) second = s;
    }
    // Close enough, and clearly closer than any other line (12 similar <h2> lines → don't guess).
    if (best >= 0 && score >= 0.6 && (score >= 1 || score - second >= 0.12)) {
      map.push(best);
      last = best;
    } else map.push(-1);
  }
  const hits = map.filter((i) => i >= 0);
  if (!hits.length) return null;
  const from = hits[0];
  const to = hits[hits.length - 1];
  const out = [];
  let p = from;
  let indent = /^\s*/.exec(file[from])[0];
  snip.forEach((line, k) => {
    const i = map[k];
    if (i < 0) {
      out.push(indent + line.trim());
      return;
    }
    while (p < i) out.push(file[p++]);
    indent = /^\s*/.exec(file[i])[0];
    out.push(indent + line.trim());
    p = i + 1;
  });
  const before = file.slice(from, to + 1);
  if (out.join('\n') === before.join('\n')) return null; // the model changed nothing
  const merged = [...file.slice(0, from), ...out, ...file.slice(to + 1)].join('\n') + (content.endsWith('\n') ? '\n' : '');
  return { content: merged, old: before.join('\n'), new: out.join('\n') };
}
