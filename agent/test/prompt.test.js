import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMessages, filesBlock, proseOf, tokens } from "../src/prompt.js";

test("messages always fit the context window", () => {
  const big = "x".repeat(200000);
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ${"y".repeat(2000)}` }));
  const msgs = buildMessages({ history, request: "change it", files: { "a.js": big, "b.css": "body{}" }, ctx: 8192, maxReply: 2048 });
  const used = msgs.reduce((n, m) => n + tokens(m.content), 0);
  assert.ok(used <= 8192 - 2048, `used ${used}`);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "user");
  assert.match(msgs.at(-1).content, /Too big to show here, don't edit these: a\.js/);
  assert.match(msgs.at(-1).content, /b\.css/);
});

test("files are shown exactly as stored (no line numbers to copy by mistake)", () => {
  const out = filesBlock({ "index.html": "<h1>Hi</h1>" }, 1000);
  assert.match(out, /index\.html\n```html\n<h1>Hi<\/h1>\n```/);
});

test("prose hides code blocks and their path lines", () => {
  const reply = "I'll make it blue.\n\nstyle.css\n```css\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```\n\nDone!";
  assert.equal(proseOf(reply), "I'll make it blue.\n\nDone!");
});
