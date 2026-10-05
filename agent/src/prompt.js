// Builds what the model reads each turn: the rules, recent chat, and the
// project's current files (always fresh, so SEARCH lines match the real file).

export const SYSTEM_PROMPT = `You are Buddo, a coding agent that builds and edits projects in the user's browser.
The user sees a live preview of their website and the project's files.

How you change files (this is the ONLY way changes happen):

1. To edit an existing file, write SEARCH/REPLACE blocks. Put the file path on its own line, then a fenced block:

index.html
\`\`\`html
<<<<<<< SEARCH
    <h1>Old title</h1>
=======
    <h1>New title</h1>
>>>>>>> REPLACE
\`\`\`

- SEARCH must copy the existing lines EXACTLY, character for character, from the current file.
- Include only the lines that change, plus a line of context if needed to make them unique.
- NEVER repeat a whole file or unchanged code. Use several small blocks for several changes.
- To delete lines, leave REPLACE empty.

2. To create a NEW file, use an empty SEARCH:

style.css
\`\`\`css
<<<<<<< SEARCH
=======
body { font-family: sans-serif; }
>>>>>>> REPLACE
\`\`\`

Rules:
- Websites: start with index.html, style.css and script.js and link them with relative paths.
- Write complete, working code. Don't use placeholders like "...".
- Before the blocks, say in one or two short sentences what you'll do. After them, stop.
- If the user is just chatting or asking a question, answer normally without blocks.`;

// Rough token estimate: code averages ~3.3 characters per token.
export const tokens = (s) => Math.ceil(s.length / 3.3);

const LANG = { html: "html", htm: "html", css: "css", js: "javascript", mjs: "javascript", json: "json", py: "python", md: "markdown", ts: "typescript", svg: "xml", txt: "" };
export const langOf = (path) => LANG[path.split(".").pop().toLowerCase()] ?? "";

export function filesBlock(files, budgetTokens, focus = []) {
  const paths = Object.keys(files).sort((a, b) => (focus.includes(b) ? 1 : 0) - (focus.includes(a) ? 1 : 0) || a.localeCompare(b));
  if (!paths.length) return "The project is empty. Create the files it needs.";
  let out = "Current project files:\n";
  let left = budgetTokens - tokens(out);
  const skipped = [];
  for (const p of paths) {
    const part = `\n${p}\n\`\`\`${langOf(p)}\n${files[p]}\n\`\`\`\n`;
    if (tokens(part) <= left) {
      out += part;
      left -= tokens(part);
    } else {
      skipped.push(p);
    }
  }
  if (skipped.length) out += `\n(Too big to show here, don't edit these: ${skipped.join(", ")})\n`;
  return out;
}

/**
 * history: [{role: "user"|"assistant", content}] of earlier turns (raw text).
 * Returns chat messages that fit the model's context window.
 */
export function buildMessages({ history, request, files, ctx, maxReply }) {
  const budget = ctx - maxReply - tokens(SYSTEM_PROMPT) - 64;
  // Files get up to 70% of the room; recent chat gets the rest.
  const filesText = filesBlock(files, Math.floor(budget * 0.7));
  const last = `${filesText}\n\nRequest: ${request}`;
  let room = budget - tokens(last);
  const kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = tokens(history[i].content);
    if (t > room) break;
    kept.unshift(history[i]);
    room -= t;
  }
  while (kept.length && kept[0].role !== "user") kept.shift(); // must start with a user turn
  return [{ role: "system", content: SYSTEM_PROMPT }, ...kept, { role: "user", content: last }];
}

export function retryMessage(errors, files, paths, budgetTokens) {
  const shown = Object.fromEntries(paths.filter((p) => p in files).map((p) => [p, files[p]]));
  return `Some of your edits could not be applied:\n- ${errors.join("\n- ")}\n\nWrite corrected SEARCH/REPLACE blocks for just those edits. The edits that worked are already applied.\n\n${filesBlock(shown, budgetTokens)}`;
}

/** The parts of a reply meant for the user: everything except the code blocks. */
export function proseOf(reply) {
  const lines = reply.split("\n");
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      if (!inFence && out.length && /^[\w.\-/]+\.[A-Za-z0-9]+:?\s*$/.test(out[out.length - 1].trim())) out.pop(); // the path line
      inFence = !inFence;
      continue;
    }
    if (inFence || /^(<{5,9}|={5,9}|>{5,9})/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
