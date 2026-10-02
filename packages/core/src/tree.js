// Helpers shared by every workspace implementation: ignore rules, glob, search, tree.

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.venv', 'venv',
  '__pycache__', '.cache', 'target', 'coverage', '.turbo', '.parcel-cache', '.idea', '.vscode', '.gradle',
  'Pods', 'DerivedData', '.dart_tool', 'vendor', '.terraform', '.pytest_cache', '.mypy_cache',
]);

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|psd|mp[34]|mov|avi|mkv|webm|wav|flac|ogg|zip|gz|tgz|bz2|xz|7z|rar|jar|war|pdf|docx?|xlsx?|pptx?|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|o|a|class|pyc|wasm|db|sqlite|lock)$/i;

export function isTextLike(path) {
  return !BINARY_EXT.test(path);
}

function esc(c) {
  return c.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

export function globToRegExp(glob) {
  let g = glob.trim().replace(/^\.\//, '');
  let re = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      const j = g.indexOf('}', i);
      if (j > i) {
        re += '(?:' + g.slice(i + 1, j).split(',').map((p) => p.split('').map((ch) => (ch === '*' ? '[^/]*' : esc(ch))).join('')).join('|') + ')';
        i = j + 1;
        continue;
      }
    }
    re += esc(c);
    i++;
  }
  // Patterns without a slash match a basename anywhere.
  if (!g.includes('/')) re = '(?:.*/)?' + re;
  return new RegExp('^' + re + '$', 'i');
}

export function matchGlob(files, pattern) {
  const re = globToRegExp(pattern);
  return files.filter((f) => re.test(f));
}

/** Search text files. `files` is an array of relative paths, `read` an async reader. */
export async function searchFiles({ files, read, pattern, glob, limit = 120 }) {
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  const list = (glob ? matchGlob(files, glob) : files).filter(isTextLike);
  const hits = [];
  for (const file of list) {
    let text;
    try {
      text = await read(file);
    } catch {
      continue;
    }
    if (text.length > 2_000_000 || text.includes('\u0000')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push({ file, line: i + 1, text: lines[i] });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

/** entries: [{path, type}] relative paths → indented tree text. */
export function formatTree(entries, base = '.', max = 400) {
  const sorted = [...entries].sort((x, y) => {
    const px = x.path.split('/');
    const py = y.path.split('/');
    for (let i = 0; i < Math.min(px.length, py.length); i++) {
      if (px[i] !== py[i]) {
        const xDir = i < px.length - 1 || x.type === 'dir';
        const yDir = i < py.length - 1 || y.type === 'dir';
        if (xDir !== yDir) return xDir ? -1 : 1;
        return px[i].localeCompare(py[i]);
      }
    }
    return px.length - py.length;
  });
  const prefix = base === '.' || base === '' ? '' : base.replace(/\/$/, '') + '/';
  const lines = [];
  for (const e of sorted.slice(0, max)) {
    const rel = prefix && e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path;
    const parts = rel.split('/');
    lines.push('  '.repeat(parts.length - 1) + parts[parts.length - 1] + (e.type === 'dir' ? '/' : ''));
  }
  if (sorted.length > max) lines.push(`… and ${sorted.length - max} more`);
  return lines.join('\n');
}

export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  let t = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(+n) + ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  return (title ? `Title: ${title}\n\n` : '') + t;
}
