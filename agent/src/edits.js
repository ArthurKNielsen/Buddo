// Buddo's editing rules, enforced in code (not by asking the model nicely):
//
//   * An existing file can ONLY change through SEARCH/REPLACE blocks: the model
//     quotes the exact lines to change and gives their replacement. Only those
//     lines are touched, no matter how big the file is.
//   * A whole file can only be written when it is being created.
//   * A block whose SEARCH covers most of a large file is refused as a rewrite.
//
// Format (the "diff" format coding models are trained on):
//
//   path/to/file.html
//   ```html
//   <<<<<<< SEARCH
//   old lines (empty when creating a file)
//   =======
//   new lines
//   >>>>>>> REPLACE
//   ```

const SEARCH = /^<{5,9} ?SEARCH\b.*$/;
const DIVIDER = /^={5,9}\s*$/;
const REPLACE = /^>{5,9} ?REPLACE\b.*$/;
const FENCE = /^\s*```/;

// Rewrites that touch more than this share of a file of at least this many lines are refused.
export const REWRITE_SHARE = 0.8;
export const REWRITE_MIN_LINES = 30;

export function cleanPath(line) {
  let p = line.trim();
  p = p.replace(/^#+\s*/, "").replace(/^(file(name)?|path)\s*:\s*/i, "");
  p = p.replace(/^[*_`"']+|[*_`"':]+$/g, "").trim();
  p = p.replace(/^\.\//, "").replace(/^\/+/, "");
  return p;
}

function looksLikePath(p) {
  return p.length > 0 && p.length < 200 && /^[\w.\-/]+\.[A-Za-z0-9]+$/.test(p) && !p.includes("..");
}

/** Find every SEARCH/REPLACE block in a model reply. */
export function parseBlocks(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let lastPath = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!SEARCH.test(line)) {
      const candidate = cleanPath(line);
      if (!FENCE.test(line) && looksLikePath(candidate)) lastPath = candidate;
      continue;
    }
    // The path is the nearest earlier non-blank line that looks like one (usually right above the fence).
    let path = null;
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      const l = lines[j];
      if (!l.trim()) continue;
      if (FENCE.test(l)) {
        const rest = cleanPath(l.replace(/^\s*```[\w+-]*\s*/, ""));
        if (looksLikePath(rest)) {
          path = rest;
          break;
        }
        continue;
      }
      if (looksLikePath(cleanPath(l))) path = cleanPath(l);
      break;
    }
    path = path || lastPath;
    const search = [];
    const replace = [];
    let j = i + 1;
    while (j < lines.length && !DIVIDER.test(lines[j])) search.push(lines[j++]);
    if (j >= lines.length) break; // unfinished block (e.g. still streaming)
    j++;
    while (j < lines.length && !REPLACE.test(lines[j])) replace.push(lines[j++]);
    if (j >= lines.length) break;
    blocks.push({ path, search: search.join("\n"), replace: replace.join("\n") });
    lastPath = path;
    i = j;
  }
  return blocks;
}

/**
 * Whole files written as a fenced code block under a filename, used by small
 * models for brand-new files. Only ever accepted for files that don't exist yet.
 */
export function parseNewFiles(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FENCE.test(lines[i])) continue;
    let path = null;
    const inline = lines[i].replace(/^\s*```[\w+-]*\s*/, "");
    if (inline && looksLikePath(cleanPath(inline))) path = cleanPath(inline);
    for (let k = i - 1; !path && k >= 0 && k >= i - 2; k--) {
      if (!lines[k].trim()) continue;
      if (looksLikePath(cleanPath(lines[k]))) path = cleanPath(lines[k]);
      break;
    }
    let j = i + 1;
    const body = [];
    while (j < lines.length && !FENCE.test(lines[j])) body.push(lines[j++]);
    if (j >= lines.length) break;
    if (path && !body.some((l) => SEARCH.test(l))) out.push({ path, content: body.join("\n") });
    i = j;
  }
  return out;
}

function findExact(content, search) {
  const at = content.indexOf(search);
  return at < 0 ? null : { start: at, end: at + search.length };
}

// Line-based match that forgives trailing spaces and a consistent indentation shift.
function findLoose(content, search) {
  const fileLines = content.split("\n");
  const want = search.split("\n");
  while (want.length && !want[want.length - 1].trim()) want.pop();
  while (want.length && !want[0].trim()) want.shift();
  if (!want.length) return null;
  const norm = (s) => s.trim();
  for (let i = 0; i + want.length <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (norm(fileLines[i + k]) !== norm(want[k])) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const indentOf = (s) => s.match(/^\s*/)[0];
    const firstReal = want.findIndex((l) => l.trim());
    const shift = indentOf(fileLines[i + firstReal]).length - indentOf(want[firstReal]).length;
    return { lineStart: i, lineCount: want.length, shift };
  }
  return null;
}

function reindent(text, shift) {
  if (!shift) return text;
  return text
    .split("\n")
    .map((l) => (!l.trim() ? l : shift > 0 ? " ".repeat(shift) + l : l.replace(new RegExp(`^ {0,${-shift}}`), "")))
    .join("\n");
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

/**
 * Apply a model reply to the project. Returns the new files plus a list of
 * changes (for the diff view) and errors (sent back to the model to retry).
 */
export function applyReply(files, reply) {
  const next = { ...files };
  const changes = [];
  const errors = [];

  for (const block of parseBlocks(reply)) {
    const { path, search, replace } = block;
    if (!path) {
      errors.push("A SEARCH/REPLACE block had no file path above it. Put the file path on the line before the ```.");
      continue;
    }
    const exists = Object.prototype.hasOwnProperty.call(next, path);
    const current = exists ? next[path] : "";

    if (!search.trim()) {
      if (exists && current.trim()) {
        errors.push(`${path} already exists, so it can't be rewritten. Use SEARCH/REPLACE blocks that quote only the lines to change.`);
        continue;
      }
      next[path] = replace;
      changes.push({ path, kind: "create", startLine: 1, removed: [], added: replace.split("\n") });
      continue;
    }
    if (!exists) {
      errors.push(`${path} doesn't exist. To create it, leave the SEARCH section empty.`);
      continue;
    }

    const fileLines = current.split("\n");
    const searchLines = search.split("\n").length;
    if (fileLines.length >= REWRITE_MIN_LINES && searchLines / fileLines.length >= REWRITE_SHARE) {
      errors.push(`That edit to ${path} quoted ${searchLines} of its ${fileLines.length} lines. Rewriting whole files isn't allowed: quote only the few lines that change.`);
      continue;
    }

    const exact = findExact(current, search);
    if (exact) {
      next[path] = current.slice(0, exact.start) + replace + current.slice(exact.end);
      changes.push({ path, kind: "edit", startLine: lineOf(current, exact.start), removed: search.split("\n"), added: replace.split("\n") });
      continue;
    }
    const loose = findLoose(current, search);
    if (loose) {
      const before = fileLines.slice(0, loose.lineStart);
      const removed = fileLines.slice(loose.lineStart, loose.lineStart + loose.lineCount);
      const after = fileLines.slice(loose.lineStart + loose.lineCount);
      const trimmed = replace.replace(/^\n+|\n+$/g, "");
      const added = trimmed ? reindent(trimmed, loose.shift).split("\n") : [];
      next[path] = [...before, ...added, ...after].join("\n");
      changes.push({ path, kind: "edit", startLine: loose.lineStart + 1, removed, added });
      continue;
    }
    errors.push(`In ${path}, these SEARCH lines were not found:\n${search}\nCopy the lines exactly as they appear in the file.`);
  }

  // Small models sometimes write new files as plain code blocks: fine for NEW files only.
  if (!changes.length && !errors.length) {
    for (const f of parseNewFiles(reply)) {
      if (Object.prototype.hasOwnProperty.call(next, f.path) && next[f.path].trim()) {
        errors.push(`${f.path} already exists, so it can't be rewritten. Use SEARCH/REPLACE blocks that quote only the lines to change.`);
        continue;
      }
      next[f.path] = f.content;
      changes.push({ path: f.path, kind: "create", startLine: 1, removed: [], added: f.content.split("\n") });
    }
  }
  return { files: next, changes, errors };
}
