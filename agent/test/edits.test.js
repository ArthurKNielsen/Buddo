import assert from "node:assert/strict";
import { test } from "node:test";
import { applyReply, parseBlocks } from "../src/edits.js";

const fence = "```";
const block = (path, search, replace, lang = "html") =>
  `${path}\n${fence}${lang}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n${fence}`;
const create = (path, content, lang = "html") =>
  `${path}\n${fence}${lang}\n<<<<<<< SEARCH\n=======\n${content}\n>>>>>>> REPLACE\n${fence}`;

test("creates a new file from an empty SEARCH", () => {
  const r = applyReply({}, `Here you go:\n\n${create("index.html", "<h1>Hi</h1>")}`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.files["index.html"], "<h1>Hi</h1>");
  assert.equal(r.changes[0].kind, "create");
});

test("edits only the quoted lines of a huge file", () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
  const files = { "big.js": lines.join("\n") };
  const r = applyReply(files, block("big.js", "line 1000", "line one thousand", "js"));
  assert.deepEqual(r.errors, []);
  const out = r.files["big.js"].split("\n");
  assert.equal(out.length, 2000);
  assert.equal(out[999], "line one thousand");
  const changed = out.filter((l, i) => l !== lines[i]);
  assert.deepEqual(changed, ["line one thousand"]);
  assert.equal(r.changes[0].startLine, 1000);
});

test("refuses to rewrite an existing file with an empty SEARCH", () => {
  const files = { "index.html": "<h1>Old</h1>" };
  const r = applyReply(files, create("index.html", "<h1>Totally new</h1>"));
  assert.equal(r.files["index.html"], "<h1>Old</h1>");
  assert.match(r.errors[0], /can't be rewritten/);
});

test("refuses a SEARCH that quotes most of a large file", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `x${i}`);
  const files = { "a.js": lines.join("\n") };
  const r = applyReply(files, block("a.js", lines.slice(0, 45).join("\n"), "y", "js"));
  assert.equal(r.files["a.js"], files["a.js"]);
  assert.match(r.errors[0], /Rewriting whole files isn't allowed/);
});

test("refuses whole-file code blocks for existing files", () => {
  const files = { "style.css": "body { color: red; }" };
  const r = applyReply(files, `style.css\n${fence}css\nbody { color: blue; }\n${fence}`);
  assert.equal(r.files["style.css"], "body { color: red; }");
  assert.match(r.errors[0], /can't be rewritten/);
});

test("accepts whole-file code blocks for brand-new files", () => {
  const r = applyReply({}, `index.html\n${fence}html\n<p>new</p>\n${fence}\n\nstyle.css\n${fence}css\np { color: red; }\n${fence}`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.files["index.html"], "<p>new</p>");
  assert.equal(r.files["style.css"], "p { color: red; }");
});

test("forgives indentation differences and re-indents the replacement", () => {
  const files = { "app.js": "function a() {\n    if (x) {\n        go();\n    }\n}" };
  const r = applyReply(files, block("app.js", "if (x) {\n    go();\n}", "if (x) {\n    go();\n    stop();\n}", "js"));
  assert.deepEqual(r.errors, []);
  assert.equal(r.files["app.js"], "function a() {\n    if (x) {\n        go();\n        stop();\n    }\n}");
});

test("reports SEARCH text that isn't in the file", () => {
  const r = applyReply({ "a.js": "let a = 1;" }, block("a.js", "let b = 2;", "let b = 3;", "js"));
  assert.match(r.errors[0], /were not found/);
  assert.equal(r.files["a.js"], "let a = 1;");
});

test("handles several blocks for several files, path above or inside the fence", () => {
  const files = { "index.html": "<title>A</title>\n<body></body>", "style.css": "body {}\nh1 { color: red; }" };
  const reply = [
    "I'll change the title and the color.",
    block("index.html", "<title>A</title>", "<title>B</title>"),
    `${fence}css style.css\n<<<<<<< SEARCH\nh1 { color: red; }\n=======\nh1 { color: green; }\n>>>>>>> REPLACE\n${fence}`,
    "Updated style.css with the new color.",
  ].join("\n\n");
  const r = applyReply(files, reply);
  assert.deepEqual(r.errors, []);
  assert.equal(r.files["index.html"], "<title>B</title>\n<body></body>");
  assert.equal(r.files["style.css"], "body {}\nh1 { color: green; }");
});

test("a block with no path is an error, and prose isn't mistaken for a path", () => {
  const blocks = parseBlocks(`Updated style.css as asked.\n${fence}\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n${fence}`);
  assert.equal(blocks[0].path, null);
});

test("ignores an unfinished block while the reply is still streaming", () => {
  const r = applyReply({ "a.js": "x" }, `a.js\n${fence}js\n<<<<<<< SEARCH\nx\n=======\ny`);
  assert.deepEqual(r.changes, []);
  assert.equal(r.files["a.js"], "x");
});

test("deletes lines with an empty REPLACE", () => {
  const r = applyReply({ "a.js": "one\ntwo\nthree" }, block("a.js", "two\n", "", "js"));
  assert.deepEqual(r.errors, []);
  assert.equal(r.files["a.js"], "one\nthree");
});
