// "Make a green button" should give a button that IS green. Tiny models often just write the word on it
// (<button>Green Button</button>), so Buddo checks that the code actually sets the color it was asked for.

const NAMES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'black', 'white', 'gray', 'brown'];
const ALIASES = {
  violet: 'purple', grey: 'gray', teal: 'green', lime: 'green', olive: 'green', cyan: 'blue', navy: 'blue', indigo: 'purple',
  magenta: 'pink', fuchsia: 'pink', crimson: 'red', maroon: 'red', tomato: 'red', firebrick: 'red', gold: 'yellow', silver: 'gray',
  lavender: 'purple', orchid: 'purple', plum: 'purple', coral: 'orange', salmon: 'orange', chocolate: 'brown', tan: 'brown', azure: 'blue',
  aqua: 'blue', turquoise: 'blue', khaki: 'yellow', beige: 'white', ivory: 'white', snow: 'white', charcoal: 'gray',
};
const WORD = new RegExp(`\\b(${[...NAMES, ...Object.keys(ALIASES)].join('|')})\\b`, 'gi');
const base = (w) => ALIASES[w.toLowerCase()] || w.toLowerCase();

/** The colors a request asks for ("a green button" → ['green']), ignoring text it should say ("that says green"). */
export function askedColors(text = '') {
  const t = text
    .replace(/["“”'‘’][^"“”'‘’]*["“”'‘’]/g, ' ')
    .replace(/\b(says?|saying|reads?|labell?ed|named|called|with the (?:text|word|label))\b[\s\S]*$/i, ' ');
  return [...new Set([...t.matchAll(WORD)].map((m) => base(m[1])))];
}

/** The color family of an RGB value. */
function family(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.15 || d < 0.08) return l < 0.2 ? 'black' : l > 0.85 ? 'white' : 'gray';
  let h;
  const [R, G, B] = [r / 255, g / 255, b / 255];
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return l < 0.35 && s < 0.6 ? 'brown' : 'red';
  if (h < 45) return l < 0.35 ? 'brown' : 'orange';
  if (h < 70) return 'yellow';
  if (h < 170) return 'green';
  if (h < 260) return 'blue';
  if (h < 300) return 'purple';
  return 'pink';
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * The style values a file sets: CSS declaration values (not selectors, so a ".green-btn" class with no
 * styling doesn't count), strings in scripts (el.style.background = "green"), color attributes and
 * utility classes like bg-green-500.
 */
function styleValues(code = '', lang = '') {
  // A page (tags in it); bare lines like "background-color: green;" are CSS whatever the block says.
  const html = !/^(css|s[ac]ss|less|m?jsx?|tsx?)$/.test(lang) && /<[a-z][\s\S]*>/i.test(code);
  const decls = html ? [...code.matchAll(/<style[^>]*>([\s\S]*?)<\/style>|\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2] ?? m[3]).join('\n') : code;
  const script = html ? [...code.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n') : /css|ss$/.test(lang) ? '' : code;
  const out = [...decls.matchAll(/:\s*([^;{}\n]+)/g)].map((m) => m[1]);
  out.push(...[...script.matchAll(/(["'`])([^"'`\n]*)\1/g)].map((m) => m[2]));
  if (html) {
    out.push(...[...code.matchAll(/\b(?:bgcolor|fill|color)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]));
    for (const m of code.matchAll(/\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) out.push(...[...(m[1] ?? m[2]).matchAll(/\b(?:bg|text|border|fill)-([a-z]+)(?:-\d+)?\b/g)].map((x) => x[1]));
  }
  return out.join('\n');
}

/** Which color families the code really sets. */
export function colorsUsed(code = '', lang = '') {
  const css = styleValues(code, lang);
  const known = [...NAMES, ...Object.keys(ALIASES)];
  const out = new Set();
  // "green", and longer names that end in one: darkgreen, skyblue, hotpink.
  for (const [w] of css.toLowerCase().matchAll(/[a-z]+/g)) for (const n of known) if (w === n || (w.length > n.length && w.endsWith(n))) out.add(base(n));
  for (const m of css.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
    if (h.length < 6) continue;
    out.add(family(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)));
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) out.add(family(+m[1], +m[2], +m[3]));
  for (const m of css.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/gi)) out.add(family(...hslToRgb(+m[1], +m[2] / 100, +m[3] / 100)));
  return out;
}

/** The asked-for colors that none of these files actually set (e.g. ['green'] for <button>Green Button</button>). */
export function missingColors(text, files = []) {
  const want = askedColors(text);
  if (!want.length) return [];
  const used = new Set(files.flatMap((f) => [...colorsUsed(f.content, f.lang)]));
  return want.filter((c) => !used.has(c));
}
