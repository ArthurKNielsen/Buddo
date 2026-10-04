import { diffLines } from './diff.js';

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
    // The closing brace keeps the indentation it had ("    }" inside a page's <style>).
    const close = /\n([ \t]*)$/.exec(match.body)?.[1] ?? '';
    const body = `\n${[...decls].map(([k, v]) => `${indent}${k}: ${v};`).join('\n')}\n${close}`;
    edits.push({ start: match.start, end: match.end, text: `${base.slice(match.start, match.start + (base.slice(match.start).indexOf('{')))}{${body}}` });
  }
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (appended.length) out = `${out.replace(/\s*$/, '')}\n\n${appended.join('\n\n')}\n`;
  return out;
}

/** Only CSS rules, no HTML or JS: "h1 {\n  color: green;\n}". */
export function isCssRules(text = '') {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!t || /<|=>|\b(function|const|let|var|return)\b/.test(t)) return false;
  // Every block holds "property: value" declarations (JS like "if (x) { y(); }" doesn't).
  const blocks = t.match(/\{[^{}]*\}/g) || [];
  return /^(?:@?[^{};]+\{(?:[^{}]|\{[^{}]*\})*\}\s*)+$/.test(t) && blocks.every((b) => /[\w-]\s*:\s*\S/.test(b) || !b.slice(1, -1).trim());
}

/** CSS for a page: merged into the stylesheet the page links, else into the page's own <style>. */
async function cssIntoPage(page, f, readKnown) {
  const linked = /<link[^>]+href=["']([^"':]+\.css)["']/i.exec(page.content)?.[1]?.replace(/^\.?\//, '');
  const sheet = linked ? await readKnown(linked) : null;
  if (sheet !== null && linked) return { ...f, path: linked, lang: 'css', before: sheet, content: mergeCss(sheet, f.content), merged: true };
  return { ...f, path: page.path, lang: 'html', before: page.content, content: mergeCssIntoHtml(page.content, f.content), merged: true };
}

/** Put CSS into an HTML page: merged into its last <style>, or a new <style> in <head>. */
export function mergeCssIntoHtml(html = '', css = '') {
  const re = /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi;
  let last = null;
  for (const m of html.matchAll(re)) last = m;
  if (last) {
    const merged = mergeCss(last[2], css);
    const at = last.index;
    // Keep the whitespace before </style> as it was.
    const tail = /\s*$/.exec(last[2])[0] || '\n';
    return html.slice(0, at) + last[1] + (merged.startsWith('\n') ? '' : '\n') + merged.replace(/\s*$/, tail) + last[3] + html.slice(at + last[0].length);
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

const REMOVAL = /\b(remove|delete|get rid|clean ?up|strip|drop|simplify|shorten|start over|from scratch|rewrite|redo)\b/i;
/** Does this message ask to take things out (so a much shorter file is expected)? */
export const asksToRemove = (text = '') => REMOVAL.test(text);

const REMOVE_ONLY = /\b(remove|delete|get rid of|take (?:out|away)|strip|erase|cut out|drop)\b|\b(?:keep|leave) (?:only|just)\b|\bonly (?:keep|leave)\b/gi;
const OTHER_CHANGE =
  /\b(add|change|move|fix|update|edit|rename|replace|turn|increase|decrease|bigger|smaller|larger|wider|taller|cent(?:er|re)|align|darker|lighter|swap|improve|modify|put|resize|insert|create|build|write|rewrite|redo|instead|make|style)\b/i;
const KEEP_ONLY = /\b(except|other than|apart from|besides|nothing but|but (?:the|for|keep|leave)|(?:keep|leave) (?:only|just)|only (?:keep|leave))\b/i;
/**
 * A request that only takes things out ("remove the title", "delete everything except the button"):
 * 'keep' when it names what stays, 'remove' when it names what goes, null when it asks for more than removing.
 */
export function removalKind(text = '') {
  if (!new RegExp(REMOVE_ONLY.source, 'i').test(text) || OTHER_CHANGE.test(text.replace(REMOVE_ONLY, ' '))) return null;
  if (/^\s*(how|what|why|where|when|which|explain|should i|do i|does)\b/i.test(text)) return null; // a question, not a request
  return KEEP_ONLY.test(text) ? 'keep' : 'remove';
}

// Placeholders a model writes instead of the code it left out: "...", "// rest of the code", "<!-- existing styles -->".
const PLACEHOLDER = /^\s*(?:\.{3}|…|(?:\/\/|\/\*|#|<!--)\s*(?:(?:\.{3}|…)[^\n]*|(?:the )?(?:rest|remaining|existing|previous|same|other|unchanged|more)\b[^\n]*|keep (?:the )?(?:rest|existing|same|everything|other)\b[^\n]*|your (?:code|content|existing|other)\b[^\n]*)(?:\*\/|-->)?\s*)$/im;
/** Did the model leave parts of the file out ("// ... rest of the code")? */
export const hasPlaceholders = (code = '') => PLACEHOLDER.test(code);

/** The local stylesheets and scripts an HTML page links to. */
export function linkedFiles(html = '') {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*\bhref=["']([^"':?#]+\.css)["']/gi)) out.push(m[1]);
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"':?#]+\.m?js)["']/gi)) out.push(m[1]);
  return [...new Set(out.map((p) => p.replace(/^\.?\//, '')))];
}

/**
 * Turn a whole-file rewrite into the few line edits it really makes: [{ old, new }], each `old` unique in
 * `before`. Returns [] when nothing changed, or null when the rewrite changes too much to split up.
 */
export function rewriteAsEdits(before = '', after = '', { maxHunks = 12 } = {}) {
  if (before === after) return [];
  const rows = diffLines(before.replace(/\n$/, ''), after.replace(/\n$/, ''));
  const A = before.replace(/\n$/, '').split('\n');
  // Changed regions in old-file line numbers: [start, end) of old lines, plus the new lines that replace them.
  const regions = [];
  let ai = 0;
  let cur = null;
  for (const r of rows) {
    if (r.type === ' ') {
      if (cur) regions.push(cur), (cur = null);
      ai = r.a;
      continue;
    }
    if (!cur) cur = { start: ai, end: ai, add: [] };
    if (r.type === '-') cur.end = r.a, (ai = r.a);
    else cur.add.push(r.text);
  }
  if (cur) regions.push(cur);
  if (!regions.length) return [];
  if (regions.length > maxHunks) return null;
  const count = (text) => {
    let n = 0;
    for (let i = before.indexOf(text); i !== -1; i = before.indexOf(text, i + 1)) n++;
    return n;
  };
  // Grow each region by context lines until its old text is unique (an insertion always gets one).
  const hunks = regions.map((g) => {
    let lo = g.start;
    let hi = g.end;
    if (lo === hi) lo > 0 ? lo-- : hi < A.length && hi++;
    while (count(A.slice(lo, hi).join('\n')) !== 1 || !A.slice(lo, hi).join('').trim()) {
      if (lo === 0 && hi >= A.length) return null;
      if (lo > 0) lo--;
      if (hi < A.length) hi++;
    }
    return { lo, hi, g };
  });
  if (hunks.includes(null)) return null;
  // Hunks whose context touches are merged into one.
  const merged = [];
  for (const h of hunks) {
    const last = merged[merged.length - 1];
    if (last && h.lo <= last.hi) {
      last.hi = Math.max(last.hi, h.hi);
      last.parts.push(h.g);
    } else merged.push({ lo: h.lo, hi: h.hi, parts: [h.g] });
  }
  return merged.map(({ lo, hi, parts }) => {
    const out = [];
    let i = lo;
    for (const g of parts) {
      while (i < g.start) out.push(A[i++]);
      out.push(...g.add);
      i = g.end;
    }
    while (i < hi) out.push(A[i++]);
    return { old: A.slice(lo, hi).join('\n'), new: out.join('\n') };
  });
}

/**
 * Decide what to do with the code files found in a reply.
 * files: from extractCodeFiles. target: { path, content } of the page being worked on (or null).
 * related: other project files the page uses ({ path, content }), where a snippet might belong instead.
 * edit: the user asked to change existing code, so existing files only get the lines that change.
 * removal: the user only asked to take things out ('remove' | 'keep', see removalKind): only deletions are saved.
 * Returns { writes: [{ path, content, before?, merged?, edit?, edits? }], needFull: boolean, unchanged: [paths
 * the model sent back without changing anything] }.
 */
export async function planCodeSave(files, { target, related = [], edit = false, removing = false, removal = null, read = async () => null } = {}) {
  if (edit && removal) return planRemoval(files, { target, related, kind: removal, read });
  const writes = [];
  const unchanged = [];
  let needFull = false;
  const known = new Map([target, ...related].filter(Boolean).map((f) => [f.path, f.content]));
  const readKnown = async (p) => (known.has(p) ? known.get(p) : read(p).catch(() => null));
  // Where a snippet with no file name may belong, most likely first.
  const candidates = (lang) => {
    const all = [target, ...related].filter(Boolean);
    const ext = { css: /\.(css|s[ac]ss|less)$/i, js: /\.m?jsx?$/i, html: /\.html?$/i }[lang];
    return ext ? [...all.filter((f) => ext.test(f.path)), ...all.filter((f) => !ext.test(f.path))] : all;
  };
  const spliceSnippet = (f, bases) => {
    for (const base of bases) {
      const m = mergeChangedLines(base.content, f.content);
      if (m) return { ...f, path: base.path, before: base.content, content: m.content, merged: true, edit: { old: m.old, new: m.new } };
    }
    return null;
  };
  for (let f of files) {
    // CSS rules ("h1 { color: green; }") labelled as the page, or with no name: they go in the page's stylesheet
    // (or its <style>), updating rules that already exist — not spliced into the HTML as if they were HTML.
    if (f.lang !== 'css' && isCssRules(f.content) && !/\.(m?jsx?|tsx?|py)$/i.test(f.path || '')) {
      const named = /\.html?$/i.test(f.path || '') ? { path: f.path, content: await readKnown(f.path) } : null;
      const page = named?.content != null ? named : target && /\.html?$/i.test(target.path) ? target : null;
      if (page) {
        writes.push(await cssIntoPage(page, f, readKnown));
        continue;
      }
      f = { ...f, lang: 'css' };
    }
    // A complete page: replace the page being edited (keeps its name), or save as named.
    if (f.lang === 'html' && isFullHtml(f.content)) {
      const path = f.inferred && target && /\.html?$/i.test(target.path) ? target.path : f.path;
      writes.push({ ...f, path, before: edit ? await readKnown(path) : null });
      continue;
    }
    const existing = await readKnown(f.path);
    const fragmentOfTarget = edit && target && f.inferred;
    // Bare CSS lines with no selector ("color: green;"): put them where they match.
    if (f.lang === 'css' && !f.content.includes('{') && (existing !== null || fragmentOfTarget)) {
      const hit = spliceSnippet(f, existing !== null && !f.inferred ? [{ path: f.path, content: existing }] : candidates('css'));
      if (hit) writes.push(hit);
      else needFull = true;
      continue;
    }
    if (f.lang === 'css' && (fragmentOfTarget || (existing && f.content.length < existing.length * 0.6))) {
      if (existing && !(target && /\.html?$/i.test(target.path))) writes.push({ ...f, before: existing, content: mergeCss(existing, f.content), merged: true });
      else if (target) writes.push(await cssIntoPage(target, f, readKnown));
      continue;
    }
    // A snippet of an existing page/script: splice the changed lines in where they clearly belong,
    // else ask again.
    const snippet = (existing && existing.split('\n').length > 8 && f.content.length < existing.length * 0.5) || hasPlaceholders(f.content);
    if (fragmentOfTarget || (existing && snippet)) {
      const bases = existing !== null && !fragmentOfTarget ? [{ path: f.path, content: existing }] : candidates(f.lang);
      const clean = { ...f, content: f.content.split('\n').filter((l) => !PLACEHOLDER.test(l)).join('\n') };
      const hit = spliceSnippet(clean, bases);
      if (hit) writes.push(hit);
      else needFull = true;
      continue;
    }
    writes.push({ ...f, before: edit ? existing : null });
  }
  if (!edit) return { writes, needFull, unchanged };
  // Changing existing code: skip files that didn't change, and turn rewrites into the line edits they make.
  const out = [];
  for (const w of writes) {
    if (w.before == null || w.edit) {
      out.push(w);
      continue;
    }
    if (w.before.trim() === w.content.trim()) {
      unchanged.push(w.path);
      continue;
    }
    // A rewrite that quietly drops most of the file is a model that forgot the rest: don't save it.
    const shrunk = w.content.split('\n').length < w.before.split('\n').length * 0.55;
    if (!w.merged && ((shrunk && !removing) || hasPlaceholders(w.content))) {
      needFull = true;
      continue;
    }
    const edits = rewriteAsEdits(w.before, w.content);
    out.push(edits?.length ? { ...w, edits } : w);
  }
  return { writes: out, needFull, unchanged };
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

// ── Removals ──
// "Remove the title" / "remove everything except the button" should only take lines out. Whatever the model
// sends (the lines to delete, or the whole file without them), Buddo deletes just the lines that go and keeps
// every other line exactly as it was, so the model can't quietly restyle or rewrite the rest.

const selectorOf = (s) => /^([^{};]+)\{/.exec(s)?.[1].trim() || '';
const declOf = (s) => /^(?:(?:export|async)\s+)*(?:const|let|var|function\*?|class)\s+([\w$]+)/.exec(s)?.[1] || '';
/** Same element / CSS rule / declaration, written differently? */
const sameKind = (a, b) => (!!tagOf(a) && tagOf(a) === tagOf(b)) || (!!selectorOf(a) && selectorOf(a) === selectorOf(b)) || (!!declOf(a) && declOf(a) === declOf(b));

/** Is `shorter` just `line` with one stretch cut out (an attribute, a declaration)? */
function isCutOf(line, shorter) {
  if (!shorter || shorter.length >= line.length) return false;
  let p = 0;
  while (p < shorter.length && line[p] === shorter[p]) p++;
  let s = 0;
  while (s < shorter.length - p && line[line.length - 1 - s] === shorter[shorter.length - 1 - s]) s++;
  return p + s === shorter.length;
}

/**
 * The model's version of a file → the original file with only the lines (or stretches of a line) that the
 * model left out removed. Lines it changed or added are ignored: the original lines stay as they were.
 * Returns the new file, or null when nothing was removed.
 */
export function keepOnlyRemovals(before = '', after = '') {
  const A = before.replace(/\n$/, '').split('\n');
  const keys = A.map(normLine);
  const B = after.replace(/\n$/, '').split('\n');
  const rows = diffLines(keys.join('\n'), B.map(normLine).join('\n'));
  const drop = new Set();
  const trimmed = new Map();
  let gone = [];
  let added = [];
  const settle = () => {
    const cheap = gone.length * added.length > 5000;
    for (const i of gone) {
      if (!keys[i]) {
        drop.add(i);
        continue;
      }
      let best = -1;
      let score = 0;
      added.forEach((j, n) => {
        const b = normLine(B[j]);
        const s = cheap ? (sameKind(keys[i], b) ? 0.6 : 0) : similarity(keys[i], b) + (sameKind(keys[i], b) ? 0.3 : 0);
        if (s > score) [score, best] = [s, n];
      });
      if (best < 0 || score < 0.6) {
        drop.add(i);
        continue;
      }
      // A line the model only rewrote stays as it was; one it only cut a stretch out of (an attribute) is cut.
      const theirs = B[added[best]].trim();
      if (isCutOf(A[i].trim(), theirs)) trimmed.set(i, /^\s*/.exec(A[i])[0] + theirs);
      added.splice(best, 1);
    }
    gone = [];
    added = [];
  };
  for (const r of rows) {
    if (r.type === ' ') settle();
    else if (r.type === '-') gone.push(r.a - 1);
    else added.push(r.b - 1);
  }
  settle();
  // Dropping only blank lines isn't removing anything.
  if (![...drop].some((i) => keys[i]) && !trimmed.size) return null;
  const out = A.flatMap((l, i) => (drop.has(i) ? [] : [trimmed.get(i) ?? l]));
  return out.join('\n') + (before.endsWith('\n') ? '\n' : '');
}

// A line marked for deletion: "- <h1>Title</h1>" or, diff style, "-<h1>Title</h1>".
const MINUS = /^\s*-(?:\s+|(?=[<.#@}{]))(?=\S)/;
const DIFF_HEAD = /^\s*(?:@@.*@@.*|---(?:\s.*)?|\+\+\+(?:\s.*)?|diff --git.*|index [0-9a-f]+\.\.[0-9a-f]+.*)$/;
/** Is this snippet a list of lines to delete ("- " in front of each)? */
export const isMinusList = (snippet = '') => {
  const lines = snippet.split('\n').filter((l) => l.trim() && !DIFF_HEAD.test(l));
  return lines.some((l) => MINUS.test(l)) && lines.every((l) => MINUS.test(l) || /^\s*\+/.test(l) || !/^\s*-/.test(l));
};

/**
 * Delete the lines a snippet lists. In a "- " list, the minus lines go and other lines are unchanged context
 * (they only say where); without minus signs every line goes. The lines must be in the file, in order, as one
 * clear spot each. Returns the new file, or null when a line can't be found (or is ambiguous).
 */
export function deleteListedLines(content = '', snippet = '') {
  const file = content.replace(/\n$/, '').split('\n');
  const keys = file.map(normLine);
  const marked = isMinusList(snippet);
  const want = snippet
    .split('\n')
    .filter((l) => l.trim() && !DIFF_HEAD.test(l) && !(marked && /^\s*\+/.test(l)))
    .map((l) => (marked && MINUS.test(l) ? { del: true, key: normLine(l.replace(MINUS, '')) } : { del: !marked, key: normLine(l) }));
  if (!want.some((w) => w.del)) return null;
  // Each line's spot: the next match after the previous line, which must also be the only match there
  // (or the line right after the previous one, which pins it down).
  const drop = new Set();
  let last = -1;
  for (const w of want) {
    const at = [];
    for (let i = last + 1; i < keys.length; i++) if (keys[i] === w.key && !drop.has(i)) at.push(i);
    if (!at.length) return null;
    const i = at.length === 1 || (last >= 0 && at[0] === last + 1) ? at[0] : -1;
    if (i < 0) return null;
    if (w.del) drop.add(i);
    last = i;
  }
  return file.filter((_, i) => !drop.has(i)).join('\n') + (content.endsWith('\n') ? '\n' : '');
}

/**
 * For a removal request: what the model's reply takes out of each file. kind: 'remove' (it named what goes)
 * or 'keep' (it named what stays). Returns { writes, needFull, unchanged }: needFull when it can't tell what to
 * delete, unchanged lists files the model sent back with nothing removed.
 */
export async function planRemoval(files, { target, related = [], kind = 'remove', read = async () => null } = {}) {
  const writes = [];
  const unchanged = [];
  let needFull = false;
  const all = [target, ...related].filter(Boolean);
  const known = new Map(all.map((f) => [f.path, f.content]));
  const readKnown = async (p) => (known.has(p) ? known.get(p) : read(p).catch(() => null));
  for (const f of files) {
    const page = f.lang === 'html' && isFullHtml(f.content);
    let bases;
    const existing = await readKnown(f.path);
    if (existing !== null && !(f.inferred && page && target && f.path !== target.path)) bases = [{ path: f.path, content: existing }];
    else if (page && target) bases = [target];
    else if (f.inferred) {
      const ext = { css: /\.(css|s[ac]ss|less)$/i, js: /\.m?jsx?$/i, html: /\.html?$/i }[f.lang];
      bases = ext ? [...all.filter((b) => ext.test(b.path)), ...all.filter((b) => !ext.test(b.path))] : all;
    } else continue; // a new file isn't a removal
    let hit = null;
    let same = false;
    for (const base of bases) {
      const lines = base.content.split('\n').length;
      const snip = f.content.split('\n').filter((l) => l.trim());
      const first = normLine(base.content.split('\n').find((l) => l.trim()) || '');
      const whole = page || (snip.length > 2 && normLine(snip[0]) === first) || snip.length >= lines * 0.6;
      let out = null;
      if (isMinusList(f.content)) out = deleteListedLines(base.content, f.content);
      else if (whole && !hasPlaceholders(f.content)) {
        out = keepOnlyRemovals(base.content, f.content);
        if (out === null) same = true;
      } else if (kind === 'remove') out = deleteListedLines(base.content, f.content);
      if (out !== null && out !== base.content) {
        hit = { path: base.path, before: base.content, content: out, merged: true };
        break;
      }
    }
    if (hit) {
      const edits = rewriteAsEdits(hit.before, hit.content);
      writes.push(edits?.length ? { ...hit, edits } : hit);
    } else if (same) unchanged.push(bases[0].path);
    else needFull = true;
  }
  return { writes, needFull: needFull && !writes.length, unchanged };
}
