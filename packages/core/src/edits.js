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
    // A snippet of an existing page/script: we can't safely splice it in — ask for the whole file.
    if (fragmentOfTarget || (existing && existing.split('\n').length > 8 && f.content.length < existing.length * 0.5)) {
      needFull = true;
      continue;
    }
    writes.push(f);
  }
  return { writes, needFull };
}
