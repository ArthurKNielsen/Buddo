// Simple requests Buddo does itself, exactly, without asking the model: "add a green button", "change the button
// color to blue", "make the button say Start", "remove the heading", "make the text bigger". Tiny models get these
// wrong (extra stuff, the word "Green" instead of the color, the whole file rewritten), and there's only one right
// answer anyway. Anything Buddo can't do for sure (two buttons, a React app, "a button that plays a sound") goes to
// the model as before.

import { linkedFiles } from './edits.js';

// prettier-ignore
const CSS_COLORS = new Set('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' '));
const LIGHT = /^(white|snow|ivory|beige|linen|seashell|ghostwhite|floralwhite|whitesmoke|mintcream|azure|aliceblue|honeydew|lavenderblush|oldlace|cornsilk|lemonchiffon|yellow|gold|khaki|lime|cyan|aqua|pink|lightpink|wheat|moccasin|silver|gainsboro|greenyellow|chartreuse|lawngreen|springgreen|aquamarine|paleturquoise|palegreen|bisque|peachpuff|papayawhip|blanchedalmond|navajowhite|thistle|plum|turquoise|light\w*|pale\w*)$/;

/** "light blue" → "lightblue", "#0a0" / "rgb(…)" as written; null when it isn't a color. */
export function cssColor(words = '') {
  const w = words.trim().toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(w) || /^(rgb|hsl)a?\([^)]*\)$/.test(w)) return w;
  const joined = w.replace(/[\s-]+/g, '');
  if (CSS_COLORS.has(joined)) return joined;
  const plain = w.replace(/^(bright|deep|vivid|pure|nice|cool|really)\s+/, '').replace(/[\s-]+/g, '');
  return CSS_COLORS.has(plain) ? plain : null;
}

/** Is this color light (so text on it should be dark)? */
function isLight(c) {
  if (LIGHT.test(c)) return true;
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c)?.[1];
  if (!h) return false;
  const [r, g, b] = (h.length === 3 ? [...h].map((x) => x + x) : h.match(/../g)).map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── What the user said ──

const ELEMENT_WORDS = [
  [/^(buttons?|btns?)$/, 'button'],
  [/^(headings?|headers?|headlines?|titles?|h1)$/, 'heading'],
  [/^(paragraphs?|sentences?)$/, 'paragraph'],
  [/^(texts?|words?|writing|fonts?)$/, 'text'],
  [/^(links?)$/, 'link'],
  [/^(inputs?|text ?box(?:es)?|textbox(?:es)?|fields?|input ?box(?:es)?)$/, 'input'],
  [/^(images?|pictures?|photos?|imgs?)$/, 'image'],
  [/^(backgrounds?|page|website|site|body|screen)$/, 'page'],
];
// "the green button": a color word may come first (it only describes which one).
const ADJ = String.raw`(?:(?:light|dark|bright)?(?:${[...CSS_COLORS].join('|')}) )?`;
const EL = String.raw`(?:the |my |this |that |your |our |all (?:the )?)?${ADJ}(?<el>buttons?|btns?|headings?|headers?|headlines?|titles?|h1|paragraphs?|sentences?|texts?|words?|writing|fonts?|links?|inputs?|text ?box(?:es)?|textbox(?:es)?|input ?box(?:es)?|fields?|images?|pictures?|photos?|imgs?|backgrounds?|page|website|site|body|screen)(?:'s|’s|s')?`;
const elementOf = (w = '') => ELEMENT_WORDS.find(([re]) => re.test(w.toLowerCase().trim()))?.[1] || null;
const plural = (w = '') => /[^s]s$|es$/i.test(w.trim()) && !/^(texts|words|fonts)$/i.test(w.trim());
// "color", and the ways it gets mistyped on a phone ("coloe", "colro", "clor").
const COLOR_WORD = /^(colou?r\w*|colo\w?|colr\w*|clou?r\w*|culou?r\w*|coulou?r|coler|collor)$/i;

/** Strip "please", "can you", "Buddo," and the final period. */
function tidy(text = '') {
  return text
    .trim()
    .replace(/^(?:hey |hi |ok |okay |so |now |and )*(?:buddo[,:]?\s*)?/i, '')
    .replace(/^(?:(?:can|could|would|will) you |please |pls |plz |just |go |now |i want you to |i'd like you to |i would like you to )+/i, '')
    .replace(/\s*(?:,?\s*(?:please|pls|plz|thanks|thank you|thx|ty))?\s*[.!]*\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text the user wants an element to say: quotes stripped. */
const said = (s = '') => s.trim().replace(/^["“'‘](.*)["”'’]$/, '$1').trim();

/**
 * Read a request as one simple action, or null:
 *  { action: 'color', el, part: 'background'|'text', color } · { action: 'text', el, text } · { action: 'remove', el, all, near }
 *  { action: 'size', el, factor } · { action: 'create', el, color, text }
 */
export function parseQuick(request = '') {
  if (/\n/.test(request.trim()) || request.length > 160) return null;
  const t = tidy(request);
  let m;

  // Create: "add a green button", "make a red heading that says Welcome"
  m = new RegExp(String.raw`^(?:add|make|create|build|put|insert|give me|i want|i need|i'd like|i would like)(?: me| us)? (?:a|an|one|another|1)(?: new)? (?<rest>.+)$`, 'i').exec(t);
  if (m) {
    let rest = m.groups.rest.replace(/ (?:to|on|at the (?:bottom|end) of|in) (?:the |my |this )?(?:page|website|site|it)$/i, '');
    let text = null;
    const label = /^(?<head>.+?),? (?:that|which|with the|with) (?:says?|reads?|text|label|words?)(?: of)?:? (?<text>.+)$|^(?<head2>.+?),? (?:saying|reading|labell?ed|called|named) (?<text2>.+)$/i.exec(rest);
    if (label) {
      rest = label.groups.head ?? label.groups.head2;
      text = said(label.groups.text ?? label.groups.text2);
    }
    let color = null;
    let elWord = rest;
    const pre = /^(?<c>.+?) (?<el>\S+(?: ?box)?)$/i.exec(rest);
    if (pre && elementOf(pre.groups.el)) {
      color = cssColor(pre.groups.c);
      if (!color) return null; // "a big button", "a login button": more than Buddo knows
      elWord = pre.groups.el;
    } else {
      const post = /^(?<el>\S+(?: ?box)?) (?:in|colored|coloured|that is|that's|which is) (?<c>.+)$/i.exec(rest);
      if (post) {
        color = cssColor(post.groups.c);
        if (!color) return null;
        elWord = post.groups.el;
      }
    }
    const el = elementOf(elWord);
    if (!el || el === 'image' || el === 'page') return null;
    return { action: 'create', el: el === 'text' ? 'paragraph' : el, color, text };
  }

  // Remove: "remove the heading", "delete the text above the button"
  m = new RegExp(String.raw`^(?:remove|delete|get rid of|take out|take away|erase) (?:the |that |this |my )?(?:text|words?|writing|line|thing|stuff|heading|title) (?<near>above|over|on top of|before|below|under|underneath|after) ${EL}$`, 'i').exec(t);
  if (m) {
    const el = elementOf(m.groups.el);
    return el && el !== 'page' ? { action: 'remove', el, near: /above|over|top|before/i.test(m.groups.near) ? 'above' : 'below' } : null;
  }
  m = new RegExp(String.raw`^(?:remove|delete|get rid of|take out|take away|erase) ${EL}$`, 'i').exec(t);
  if (m) {
    const el = elementOf(m.groups.el);
    return el && el !== 'page' ? { action: 'remove', el, all: /\ball (?:the )?/i.test(t) || plural(m.groups.el) } : null;
  }

  // Color: "change the button color to blue", "make the button blue", "change the background of the button to red"
  m = new RegExp(String.raw`^(?:change|make|turn|set|paint|colou?r|switch) ${EL}(?: (?<what>\S+?))??(?: colou?r)? (?:to |into |as |= ?)?(?:be |a |an )?(?<c>#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([^)]*\)|[a-z]+(?: [a-z]+)?)$`, 'i').exec(t);
  if (!m) m = new RegExp(String.raw`^(?:change|make|turn|set) the (?<what>background|bg|text|font|colou?r|text colou?r|background colou?r) (?:colou?r )?of ${EL} (?:to |into )?(?:be )?(?<c>#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([^)]*\)|[a-z]+(?: [a-z]+)?)$`, 'i').exec(t);
  if (m) {
    const color = cssColor(m.groups.c);
    const what = (m.groups.what || '').toLowerCase();
    const el = elementOf(m.groups.el);
    if (color && el && el !== 'image' && (!what || COLOR_WORD.test(what) || /^(text|font|background\w*|backround|bg|fill|text colou?r|background colou?r)$/.test(what))) {
      const textPart = /^(text|font)/.test(what) || (!what || COLOR_WORD.test(what) ? ['heading', 'paragraph', 'text', 'link'].includes(el) : false);
      return { action: 'color', el, part: textPart ? 'text' : 'background', color, all: /\ball (?:the )?/i.test(t) || plural(m.groups.el) };
    }
  }

  // Size: "make the button bigger", "make the text a lot smaller", "increase the size of the heading"
  m = new RegExp(String.raw`^(?:make|change|set) ${EL} (?<much>a (?:lot|little|bit|tiny bit) |much |slightly |way )?(?<dir>bigger|larger|smaller|tinier|huge|tiny|big|small|large)(?: (?:text|font))?$`, 'i').exec(t);
  if (!m) m = new RegExp(String.raw`^(?<dir>increase|decrease|enlarge|shrink|grow|reduce)(?: the (?:size|font size|font|text size) of)? ${EL}(?: (?:size|font size|text size|font))?$`, 'i').exec(t);
  if (m) {
    const el = elementOf(m.groups.el);
    if (!el || el === 'image') return null;
    const up = /bigger|larger|huge|big|large|increase|enlarge|grow/i.test(m.groups.dir);
    const much = /lot|much|way|huge|tiny/i.test(`${m.groups.much || ''} ${m.groups.dir}`);
    const little = /little|bit|slightly/i.test(m.groups.much || '');
    return { action: 'size', el, factor: up ? (much ? 1.5 : little ? 1.1 : 1.25) : much ? 0.67 : little ? 0.9 : 0.8, all: /\ball (?:the )?/i.test(t) || plural(m.groups.el) };
  }

  // Text: "make the button say Start", "change the heading to Welcome", "rename the button to Go"
  m = new RegExp(String.raw`^(?:make|have|let) ${EL} (?:say|says|read|reads|show|display) (?<text>.+)$|^(?:change|set|update|edit|rename) ${EL.replace('<el>', '<el2>')}(?: (?<field>text|label|words?|caption|title))? (?:to say|to read|to show|to|into|as) (?<text2>.+)$`, 'i').exec(t);
  if (m) {
    const el = elementOf(m.groups.el ?? m.groups.el2);
    const text = said(m.groups.text ?? m.groups.text2);
    const quoted = /^["“'‘]/.test((m.groups.text ?? m.groups.text2).trim());
    const plainWords = !/^(a|an|the|some|my|bigger|smaller|larger|bold|italic|cent(?:er|re)d?|left|right|hidden|visible|invisible|round(?:ed)?|square)\b/i.test(text) && text.split(' ').length <= 8;
    if (!el || el === 'page' || el === 'image' || !text || (!m.groups.text && !quoted && !m.groups.field && !/^rename/i.test(t) && !plainWords)) return null;
    if (!quoted && cssColor(text)) return null; // "change the heading to blue" is a color (handled above when it can be)
    return { action: 'text', el: el === 'text' ? 'paragraph' : el, text };
  }
  return null;
}

// ── Where it is in the page ──

const TAGS = { button: ['button'], heading: ['h1', 'h2', 'h3'], paragraph: ['p'], text: ['p'], link: ['a'], input: ['input', 'textarea'], image: ['img'], page: ['body'] };
const VOID = /^(input|img|br|hr|meta|link)$/;

/** Ranges [from, to) of <script>/<style>/comments, where tags aren't elements. */
function skipRanges(html) {
  return [...html.matchAll(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi)].map((m) => [m.index, m.index + m[0].length]);
}

/** Every <tag …>…</tag> in the page body: { tag, start, openEnd, innerEnd, end, attrs }. */
function elements(html, tag) {
  const skip = skipRanges(html);
  const inSkip = (i) => skip.some(([a, b]) => i > a && i < b);
  const out = [];
  for (const m of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))) {
    if (inSkip(m.index)) continue;
    const start = m.index;
    const openEnd = start + m[0].length;
    if (VOID.test(tag) || /\/\s*$/.test(m[1])) {
      out.push({ tag, start, openEnd, innerEnd: openEnd, end: openEnd, attrs: m[1] });
      continue;
    }
    // The matching close tag (nested same tags counted).
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    re.lastIndex = openEnd;
    let depth = 1;
    let close = null;
    for (let x; (x = re.exec(html)); ) {
      if (inSkip(x.index)) continue;
      depth += x[1] ? -1 : 1;
      if (!depth) {
        close = x;
        break;
      }
    }
    if (!close) continue;
    out.push({ tag, start, openEnd, innerEnd: close.index, end: close.index + close[0].length, attrs: m[1] });
  }
  return out;
}
const attr = (attrs, name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
const classesOf = (attrs) => (attr(attrs, 'class')?.slice(1).find((x) => x != null) || '').split(/\s+/).filter(Boolean);

/** The elements a word means: the first tag of its list that the page has (a heading is an h1, else an h2…). */
function find(html, el) {
  for (const tag of TAGS[el] || []) {
    const found = elements(html, tag);
    if (found.length) return found;
  }
  return [];
}

// ── CSS ──

/** CSS rules in [from, to) of text (top level only; @media and friends are left alone). */
function rules(text, from, to) {
  const out = [];
  let i = from;
  while (i < to) {
    const open = text.indexOf('{', i);
    if (open === -1 || open >= to) break;
    let depth = 1;
    let j = open + 1;
    for (; j < to && depth; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
    }
    const selector = text.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!selector.startsWith('@')) out.push({ selector, bodyStart: open + 1, bodyEnd: j - 1 });
    i = j;
  }
  return out;
}

/** How specifically a selector targets this element (0: not a plain selector for it). */
function targets(selector, el) {
  const classes = classesOf(el.attrs);
  const id = attr(el.attrs, 'id')?.slice(1).find((x) => x != null);
  let best = 0;
  for (const part of selector.split(',').map((s) => s.trim())) {
    const m = /^([a-z][\w-]*)?((?:\.[\w-]+)*)(#[\w-]+)?((?:\.[\w-]+)*)$/i.exec(part);
    if (!m || !part) continue;
    const cls = `${m[2]}${m[4]}`.split('.').filter(Boolean);
    if (m[1] && m[1].toLowerCase() !== el.tag) continue;
    if (cls.some((c) => !classes.includes(c))) continue;
    if (m[3] && m[3].slice(1) !== id) continue;
    best = Math.max(best, (m[3] ? 100 : 0) + cls.length * 10 + (m[1] ? 1 : 0));
  }
  return best;
}

/** Where CSS lives: the page's <style> blocks, then the stylesheets it links. */
function sheets(page, files) {
  const out = [];
  for (const m of page.content.matchAll(/(<style[^>]*>)([\s\S]*?)<\/style>/gi)) out.push({ path: page.path, from: m.index + m[1].length, to: m.index + m[1].length + m[2].length });
  const dir = page.path.includes('/') ? page.path.slice(0, page.path.lastIndexOf('/') + 1) : '';
  for (const rel of linkedFiles(page.content)) {
    const f = files.find((x) => x.path === (dir + rel).replace(/^\.\//, ''));
    if (f) out.push({ path: f.path, from: 0, to: f.content.length });
  }
  return out;
}

const PROPS = { background: ['background-color', 'background'], text: ['color'], size: ['font-size'] };

/** A declaration of one of `props` in a rule body: { start, end, value } of its value. */
function declIn(text, rule, props) {
  const body = text.slice(rule.bodyStart, rule.bodyEnd);
  let found = null;
  for (const m of body.matchAll(/(^|[;{\s])([a-z-]+)\s*:\s*([^;}]*)/gi)) {
    if (!props.includes(m[2].toLowerCase())) continue;
    const vStart = rule.bodyStart + m.index + m[0].length - m[3].length;
    const value = m[3].replace(/\s+$/, '');
    // The shorthand "background: url(…) …" isn't just a color; only a single value can be swapped.
    if (m[2].toLowerCase() === 'background' && /\s|url\(|gradient/i.test(value.replace(/\([^)]*\)/g, ''))) continue;
    found = { start: vStart, end: vStart + value.length, value: value.replace(/\s*!important$/i, '') };
  }
  return found;
}

/** Add "prop: value;" to the end of a rule, matching its layout. */
function addDecl(text, rule, prop, value) {
  const body = text.slice(rule.bodyStart, rule.bodyEnd);
  const lastChar = body.replace(/\s+$/, '');
  const at = rule.bodyStart + lastChar.length;
  const semi = lastChar.trim() && !/[;{]$/.test(lastChar.trim()) ? ';' : '';
  if (body.includes('\n')) {
    const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? '  ';
    return text.slice(0, at) + `${semi}\n${indent}${prop}: ${value};` + text.slice(at);
  }
  return text.slice(0, at) + `${semi} ${prop}: ${value};` + (/\s$/.test(body) ? '' : ' ') + text.slice(at);
}

/** Set (or add) a property in an element's style="" attribute. */
function setInline(html, el, prop, value, alsoProps = []) {
  const open = html.slice(el.start, el.openEnd);
  const st = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(open);
  let tag;
  if (st) {
    let css = st[2];
    const names = [prop, ...alsoProps];
    const re = new RegExp(`(^|;)\\s*(${names.map(reEsc).join('|')})\\s*:[^;]*`, 'i');
    css = re.test(css) ? css.replace(re, (all, lead) => `${lead}${lead ? ' ' : ''}${prop}: ${value}`) : `${css.replace(/;?\s*$/, '')}${css.trim() ? '; ' : ''}${prop}: ${value};`;
    tag = open.slice(0, st.index) + `style=${st[1]}${css}${st[1]}` + open.slice(st.index + st[0].length);
  } else tag = open.replace(/\s*(\/?)>$/, (all, slash) => ` style="${prop}: ${value};"${slash ? ' /' : ''}>`);
  return html.slice(0, el.start) + tag + html.slice(el.openEnd);
}
const inlineValue = (html, el, props) => {
  const st = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(html.slice(el.start, el.openEnd))?.[2] || '';
  for (const p of props) {
    const v = new RegExp(`(?:^|;)\\s*${reEsc(p)}\\s*:\\s*([^;]*)`, 'i').exec(st)?.[1]?.trim();
    if (v && !(p === 'background' && /\s|url\(|gradient/i.test(v))) return v;
  }
  return null;
};

/**
 * Set a style on the elements: in their style="" if they have it there, else in the CSS rule that styles them
 * (the most specific one that already sets it, else the most specific one), else in a new style="".
 * Returns { contents (path → new text) } or null when it isn't clear which one to change.
 */
function setStyle(page, files, els, propKey, value, { scale } = {}) {
  const props = PROPS[propKey];
  const out = new Map([[page.path, page.content]]);
  const get = (p) => out.get(p) ?? files.find((f) => f.path === p)?.content;
  const rulesFor = (el) =>
    sheets({ path: page.path, content: out.get(page.path) }, files.map((f) => ({ ...f, content: get(f.path) })))
      .flatMap((s) => rules(get(s.path), s.from, s.to).map((r) => ({ ...r, path: s.path, spec: targets(r.selector, el) })))
      .filter((r) => r.spec > 0);
  // One shared rule for several elements (".btn" for every button) is fine; otherwise each needs its own place.
  if (els.length > 1) {
    const shared = rulesFor(els[0]).filter((r) => els.every((e) => targets(r.selector, e) > 0));
    const hit = [...shared].reverse().find((r) => declIn(get(r.path), r, props));
    if (!hit || els.some((e) => inlineValue(get(page.path), e, props))) return null;
    const d = declIn(get(hit.path), hit, props);
    const v = scale ? scale(d.value) : value;
    if (!v) return null;
    out.set(hit.path, get(hit.path).slice(0, d.start) + v + get(hit.path).slice(d.end));
    return { contents: out, value: v };
  }
  const [el] = els;
  const html = get(page.path);
  const inline = inlineValue(html, el, props);
  if (inline !== null) {
    const v = scale ? scale(inline) : value;
    if (!v) return null;
    out.set(page.path, setInline(html, el, props[0], v, props.slice(1)));
    return { contents: out, value: v };
  }
  const mine = rulesFor(el).sort((a, b) => a.spec - b.spec);
  const withProp = mine.filter((r) => declIn(get(r.path), r, props));
  const target = withProp.at(-1);
  if (target) {
    const d = declIn(get(target.path), target, props);
    const v = scale ? scale(d.value) : value;
    if (!v) return null;
    // A more specific rule styles it but doesn't set this: put it there so it wins.
    const top = mine.at(-1);
    if (top !== target && top.spec > target.spec) {
      out.set(top.path, addDecl(get(top.path), top, props[0], v));
      return { contents: out, value: v };
    }
    out.set(target.path, get(target.path).slice(0, d.start) + v + get(target.path).slice(d.end));
    return { contents: out, value: v };
  }
  const v = scale ? scale(null) : value;
  if (!v) return null;
  const top = mine.at(-1);
  if (top) out.set(top.path, addDecl(get(top.path), top, props[0], v));
  else out.set(page.path, setInline(html, el, props[0], v));
  return { contents: out, value: v };
}

// Default font sizes, in em of the parent, for "make it bigger" when nothing sets one yet.
const DEFAULT_EM = { h1: 2, h2: 1.5, h3: 1.17, p: 1, a: 1, button: 0.85, input: 0.85, textarea: 0.85, body: 1 };
const scaleBy = (factor, tag) => (value) => {
  if (value == null) {
    if (tag === 'body') return `${Math.round(16 * factor)}px`;
    return `${+((DEFAULT_EM[tag] ?? 1) * factor).toFixed(2)}em`;
  }
  const m = /^([\d.]+)(px|em|rem|%|pt|vw|vh)$/.exec(value.trim());
  if (!m) return null; // "large", clamp(…): leave it to the model
  const n = +m[1] * factor;
  return `${m[2] === 'px' || m[2] === '%' || m[2] === 'pt' ? Math.round(n) : +n.toFixed(2)}${m[2]}`;
};

/** Delete an element: its whole line(s) when it has them to itself, else just the element. */
function cut(html, el) {
  const lineStart = html.lastIndexOf('\n', el.start - 1) + 1;
  const nl = html.indexOf('\n', el.end);
  const lineEnd = nl === -1 ? html.length : nl;
  if (!html.slice(lineStart, el.start).trim() && !html.slice(el.end, lineEnd).trim()) return html.slice(0, lineStart) + html.slice(nl === -1 ? lineEnd : nl + 1);
  return html.slice(0, el.start) + html.slice(el.end);
}

/** The text element on the line right above (or below) an element, when that line holds just one. */
function neighbor(html, el, dir) {
  const lines = html.split('\n');
  const lineOf = (i) => html.slice(0, i).split('\n').length - 1;
  const step = dir === 'above' ? -1 : 1;
  let k = (dir === 'above' ? lineOf(el.start) : lineOf(el.end)) + step;
  while (k >= 0 && k < lines.length && !lines[k].trim()) k += step;
  if (k < 0 || k >= lines.length) return null;
  const m = /^\s*<(p|h[1-6]|span|label|div|small|strong|em|b|i)\b[^>]*>[^<]*<\/\1>\s*$/i.exec(lines[k]);
  if (!m) return null;
  const start = lines.slice(0, k).join('\n').length + (k ? 1 : 0) + lines[k].search(/\S/);
  return elements(html, m[1].toLowerCase()).find((e) => e.start === start) || null;
}

/** The HTML for a new element, styled inline so it stands on its own (and later edits stay one line). */
function newElement({ el, color, text }) {
  const label = esc(text || { button: 'Click me', heading: 'Heading', paragraph: 'Some text', link: 'Link', input: 'Type here' }[el]);
  if (el === 'button') {
    const style = color ? ` style="background-color: ${color}; color: ${isLight(color) ? 'black' : 'white'}; padding: 10px 20px; font-size: 16px; border: none; border-radius: 8px; cursor: pointer;"` : '';
    return `<button${style}>${label}</button>`;
  }
  if (el === 'input') return `<input type="text" placeholder="${label}"${color ? ` style="border: 2px solid ${color}; padding: 8px; border-radius: 6px;"` : ''}>`;
  const tag = { heading: 'h1', paragraph: 'p', link: 'a' }[el];
  return `<${tag}${tag === 'a' ? ' href="#"' : ''}${color ? ` style="color: ${color};"` : ''}>${label}</${tag}>`;
}

const NAME = { button: 'button', heading: 'heading', paragraph: 'text', text: 'text', link: 'link', input: 'input', image: 'image', page: 'page' };

/**
 * Do a simple request on the page: { page: { path, content }, files: [the CSS/JS it links] }.
 * Returns { changes: [{ path, before, after }], summary } or null (not simple enough: ask the model).
 * With no page yet (an empty chat), "add a green button" makes index.html.
 */
export function quickChange(request, { page = null, files = [], empty = false } = {}) {
  const q = parseQuick(request);
  if (!q) return null;
  if (!page) {
    if (q.action !== 'create' || !empty) return null;
    const node = newElement(q);
    const title = { button: 'Button', heading: 'Heading', paragraph: 'Text', link: 'Link', input: 'Input' }[q.el];
    const content = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${title}</title>\n</head>\n<body>\n  ${node}\n</body>\n</html>\n`;
    return { changes: [{ path: 'index.html', before: null, after: content }], summary: `Made index.html with ${describe(q)}.` };
  }
  // Pages an app builds at runtime (React, Vue…) aren't edited here.
  if (/<script\b[^>]*type=["']module["'][^>]*\bsrc=|<div id=["'](root|app)["']\s*>\s*<\/div>/i.test(page.content)) return null;
  const html = page.content;
  const done = (contents, summary) => {
    const changes = [...contents]
      .map(([path, after]) => ({ path, before: path === page.path ? page.content : files.find((f) => f.path === path)?.content ?? null, after }))
      .filter((c) => c.before !== c.after);
    return changes.length ? { changes, summary } : null;
  };

  if (q.action === 'create') {
    const body = elements(html, 'body')[0];
    if (!body) return null;
    // After the last thing in the body that isn't a script, indented like it.
    const inner = html.slice(body.openEnd, body.innerEnd);
    const scriptsAtEnd = /(\s*<script\b[\s\S]*?<\/script>)*\s*$/i.exec(inner);
    const at = body.openEnd + inner.length - scriptsAtEnd[0].length;
    const before = html.slice(body.openEnd, at);
    const lastLine = before.split('\n').reverse().find((l) => l.trim()) ?? '';
    const indent = /^\s*/.exec(lastLine)[0] || /\n([ \t]*)\S/.exec(html.slice(body.openEnd))?.[1] || '  ';
    const node = newElement(q);
    return done(new Map([[page.path, `${html.slice(0, at)}\n${indent}${node}${html.slice(at)}`]]), `Added ${describe(q)} to ${page.path}.`);
  }

  const els = q.el === 'text' && q.action !== 'remove' ? elements(html, 'body').slice(0, 1) : find(html, q.el);
  if (!els.length) return null;
  const name = NAME[q.el];

  if (q.action === 'remove') {
    if (q.near) {
      if (els.length !== 1) return null;
      const n = neighbor(html, els[0], q.near);
      return n ? done(new Map([[page.path, cut(html, n)]]), `Removed the text ${q.near} the ${name} from ${page.path}.`) : null;
    }
    if (els.length > 1 && !q.all) return null;
    let out = html;
    for (const e of [...els].reverse()) out = cut(out, e);
    return done(new Map([[page.path, out]]), `Removed the ${name}${els.length > 1 ? `s (${els.length})` : ''} from ${page.path}.`);
  }

  if (q.action === 'text') {
    if (els.length !== 1) return null;
    const [e] = els;
    if (e.tag === 'input' || e.tag === 'textarea') return done(new Map([[page.path, html.slice(0, e.start) + setAttr(html.slice(e.start, e.openEnd), 'placeholder', q.text) + html.slice(e.openEnd)]]), `The ${name} now says "${q.text}".`);
    const inner = html.slice(e.openEnd, e.innerEnd);
    if (/</.test(inner)) return null; // it holds other elements (an icon, a span)
    const lead = /^\s*/.exec(inner)[0];
    const trail = /\s*$/.exec(inner)[0];
    return done(new Map([[page.path, html.slice(0, e.openEnd) + lead + esc(q.text) + trail + html.slice(e.innerEnd)]]), `The ${name} now says "${q.text}".`);
  }

  // "the button" with several buttons on the page: which one? Ask the model (it sees the page).
  if (els.length > 1 && !q.all) return null;
  const r = setStyle(page, files, els, q.action === 'size' ? 'size' : q.part, q.color, q.action === 'size' ? { scale: scaleBy(q.factor, els[0].tag) } : {});
  if (!r) return null;
  const was = (p) => (p === page.path ? page.content : files.find((f) => f.path === p)?.content);
  const where = [...r.contents].filter(([p, c]) => c !== was(p)).map(([p]) => p).join(', ') || page.path;
  return done(r.contents, summaryOf(q, name, r.value, where, els.length > 1));
}

function setAttr(open, name, value) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])[\\s\\S]*?\\1`, 'i');
  const v = esc(value).replace(/"/g, '&quot;');
  return re.test(open) ? open.replace(re, `${name}="${v}"`) : open.replace(/\s*(\/?)>$/, (all, slash) => ` ${name}="${v}"${slash ? ' /' : ''}>`);
}

function describe(q) {
  const what = { button: 'button', heading: 'heading', paragraph: 'text', link: 'link', input: 'text box' }[q.el];
  return `a ${q.color ? `${q.color} ` : ''}${what}${q.text ? ` that says "${q.text}"` : ''}`.replace(/^a ([aeiou])/, 'an $1');
}

function summaryOf(q, name, value, path, many) {
  if (q.action === 'size') return `Made the ${name}${many ? 's' : ''} ${q.factor > 1 ? 'bigger' : 'smaller'} (font-size: ${value}) in ${path}.`;
  const prop = q.part === 'text' ? 'text color' : 'background color';
  if (q.el === 'text' || q.el === 'page') return `Changed the page's ${prop} to ${value} in ${path}.`;
  return `Changed the ${many ? `${name}s'` : `${name}'s`} ${prop} to ${value} in ${path}.`;
}
