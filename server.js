import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.BUDDO_MODEL || "claude-opus-5-5";
// Total context window Buddo is allowed to use: prompt + history + reply.
const CONTEXT_LIMIT = Number(process.env.BUDDO_CONTEXT_LIMIT) || 20000;
// Slice of the window kept free for the reply (thinking counts toward it too).
const MAX_OUTPUT = Number(process.env.BUDDO_MAX_OUTPUT) || 8000;
const INPUT_BUDGET = CONTEXT_LIMIT - MAX_OUTPUT;
// Optional password so strangers can't spend your API credits on a public URL.
const PASSWORD = process.env.BUDDO_PASSWORD || "";

const SYSTEM_PROMPT = `You are Buddo, a friendly coding buddy who is especially good at Python.
- When asked for code, write complete, runnable Python 3 in a fenced \`\`\`python block.
- Keep explanations short and practical; point out anything the user must install.
- If a request is ambiguous, pick a sensible default and say what you assumed.`;

const client = new Anthropic();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

async function countTokens(messages) {
  const res = await client.messages.countTokens({
    model: MODEL,
    system: SYSTEM_PROMPT,
    messages,
  });
  return res.input_tokens;
}

// Drop the oldest exchanges until the prompt fits INPUT_BUDGET.
async function fitToContext(messages) {
  let trimmed = messages;
  let tokens = await countTokens(trimmed);
  let dropped = 0;
  while (tokens > INPUT_BUDGET && trimmed.length > 1) {
    // Remove a user+assistant pair so the history still starts with a user turn.
    trimmed = trimmed.slice(2);
    dropped += 2;
    tokens = await countTokens(trimmed);
  }
  return { messages: trimmed, tokens, dropped };
}

function isValidHistory(messages) {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.length % 2 === 1 &&
    messages.every(
      (m, i) =>
        m &&
        typeof m.content === "string" &&
        m.content.length > 0 &&
        m.role === (i % 2 === 0 ? "user" : "assistant"),
    )
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function passwordOk(req) {
  if (!PASSWORD) return true;
  const given = Buffer.from(String(req.headers["x-buddo-password"] || ""));
  const expected = Buffer.from(PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function handleChat(req, res) {
  if (!passwordOk(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Wrong password" }));
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Invalid JSON" }));
  }
  if (!isValidHistory(body.messages)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "messages must alternate user/assistant and end with user" }));
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    const fit = await fitToContext(body.messages);
    if (fit.tokens > INPUT_BUDGET) {
      send(res, "error", {
        message: `That message is too long (${fit.tokens} tokens). Keep it under ${INPUT_BUDGET} tokens.`,
      });
      return res.end();
    }
    send(res, "context", { used: fit.tokens, budget: INPUT_BUDGET, limit: CONTEXT_LIMIT, dropped: fit.dropped });

    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_OUTPUT,
      system: SYSTEM_PROMPT,
      messages: fit.messages,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      // If a safety classifier declines, the API retries on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    req.on("close", () => stream.abort());
    stream.on("text", (text) => send(res, "text", { text }));

    const final = await stream.finalMessage();
    const usage = final.usage;
    send(res, "done", {
      stopReason: final.stop_reason,
      inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err?.message)) {
      send(res, "error", { message: "No valid API key. Set ANTHROPIC_API_KEY and restart the server." });
    } else if (err instanceof Anthropic.RateLimitError) {
      send(res, "error", { message: "Rate limited — wait a moment and try again." });
    } else if (err instanceof Anthropic.APIUserAbortError) {
      // Client went away; nothing to report.
    } else if (err instanceof Anthropic.APIError) {
      send(res, "error", { message: `API error ${err.status ?? ""}: ${err.message}` });
    } else {
      console.error(err);
      send(res, "error", { message: "Something went wrong on the server." });
    }
  }
  res.end();
}

async function serveStatic(req, res) {
  const urlPath = new URL(req.url, "http://localhost").pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "GET" && req.url === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ model: MODEL, contextLimit: CONTEXT_LIMIT, inputBudget: INPUT_BUDGET, needsPassword: Boolean(PASSWORD) }));
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Buddo is running at http://localhost:${PORT} (context limit ${CONTEXT_LIMIT} tokens)`);
  // Show LAN addresses so you can open Buddo on your phone over the same Wi-Fi.
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) console.log(`  On your phone (same Wi-Fi): http://${net.address}:${PORT}`);
    }
  }
  if (!PASSWORD) console.warn("Tip: set BUDDO_PASSWORD before putting Buddo on a public URL.");
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("Heads up: ANTHROPIC_API_KEY isn't set, so chats will fail until you add one.");
  }
});
