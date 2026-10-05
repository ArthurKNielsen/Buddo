const STORAGE_KEY = "buddo-chat";
const PASSWORD_KEY = "buddo-password";

const els = {
  chat: document.getElementById("chat"),
  messages: document.getElementById("messages"),
  empty: document.getElementById("empty"),
  form: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  newChat: document.getElementById("new-chat"),
  meterFill: document.getElementById("meter-fill"),
  meterText: document.getElementById("meter-text"),
  passwordDialog: document.getElementById("password-dialog"),
  passwordForm: document.getElementById("password-form"),
  passwordInput: document.getElementById("password-input"),
};

let history = load();
let busy = false;
let contextLimit = 20000;

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    contextLimit = cfg.contextLimit;
    setMeter(0);
    if (cfg.needsPassword && !getPassword()) askPassword();
  })
  .catch(() => {});

// ---------- tiny markdown renderer (no libraries) ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

function renderMarkdown(src) {
  const out = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```\s*([\w+-]*)/);
    if (fence) {
      const lang = fence[1] || "code";
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++; // skip closing fence (may be missing while streaming)
      out.push(
        `<div class="codeblock"><header><span>${escapeHtml(lang)}</span><button type="button" data-copy>Copy</button></header>` +
          `<pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`,
      );
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("");
}

// ---------- rendering ----------

function addBubble(role, text) {
  els.empty.hidden = true;
  const row = document.createElement("div");
  row.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "user" || role === "error") bubble.textContent = text;
  else bubble.innerHTML = renderMarkdown(text);
  row.appendChild(bubble);
  els.messages.appendChild(row);
  scrollDown();
  return bubble;
}

function addNote(text) {
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = text;
  els.messages.appendChild(note);
}

function scrollDown() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

function setMeter(used) {
  const pct = Math.min(100, (used / contextLimit) * 100);
  els.meterFill.style.width = `${pct}%`;
  els.meterFill.className = pct > 90 ? "full" : pct > 70 ? "warn" : "";
  const k = (n) => `${+(n / 1000).toFixed(1)}k`;
  els.meterText.textContent = matchMedia("(max-width: 560px)").matches
    ? `${k(used)} / ${k(contextLimit)}`
    : `${used.toLocaleString()} / ${contextLimit.toLocaleString()} tokens`;
}

function renderAll() {
  els.messages.innerHTML = "";
  els.empty.hidden = history.length > 0;
  for (const m of history) addBubble(m.role, m.content);
}

// ---------- persistence (best effort) ----------

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {}
}

function getPassword() {
  try {
    return localStorage.getItem(PASSWORD_KEY) || "";
  } catch {
    return "";
  }
}

// Resolves once the user submits a password.
function askPassword() {
  return new Promise((resolve) => {
    els.passwordInput.value = "";
    els.passwordDialog.showModal();
    els.passwordForm.addEventListener(
      "submit",
      () => {
        try {
          localStorage.setItem(PASSWORD_KEY, els.passwordInput.value);
        } catch {}
        resolve();
      },
      { once: true },
    );
  });
}

class WrongPassword extends Error {}

// ---------- chat ----------

async function sendMessage(text) {
  if (busy || !text.trim()) return;
  busy = true;
  els.send.disabled = true;

  history.push({ role: "user", content: text });
  addBubble("user", text);
  const bubble = addBubble("assistant", "");
  bubble.classList.add("cursor");
  let reply = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Buddo-Password": getPassword() },
      body: JSON.stringify({ messages: history }),
    });
    if (res.status === 401) throw new WrongPassword();
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server returned ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let failed = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = raw.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(raw.match(/^data: (.*)$/m)?.[1] ?? "{}");
        if (event === "text") {
          reply += data.text;
          bubble.innerHTML = renderMarkdown(reply);
          scrollDown();
        } else if (event === "context") {
          setMeter(data.used);
          if (data.dropped > 0) {
            addNote(`Hit the ${data.limit.toLocaleString()}-token limit — Buddo forgot the oldest ${data.dropped / 2} exchange(s).`);
            els.messages.appendChild(bubble.parentElement);
          }
        } else if (event === "done") {
          setMeter(data.inputTokens + data.outputTokens);
          if (data.stopReason === "max_tokens") reply += "\n\n*(reply cut off — ask me to continue)*";
          if (data.stopReason === "refusal") reply += "\n\n*(I can't help with that one.)*";
        } else if (event === "error") {
          failed = data.message;
        }
      }
    }

    bubble.classList.remove("cursor");
    if (failed || !reply) throw new Error(failed || "Empty reply");
    bubble.innerHTML = renderMarkdown(reply);
    history.push({ role: "assistant", content: reply });
    save();
  } catch (err) {
    // Roll back the unanswered user turn so history stays user/assistant alternating.
    history.pop();
    bubble.parentElement.remove();
    if (err instanceof WrongPassword) {
      els.messages.lastElementChild?.remove(); // the user bubble; it's re-added on retry
      busy = false;
      els.send.disabled = false;
      await askPassword();
      await sendMessage(text);
      return;
    }
    addBubble("error", `⚠️ ${err.message}`);
  } finally {
    busy = false;
    els.send.disabled = false;
    // Don't pop the keyboard back open on phones.
    if (matchMedia("(pointer: fine)").matches) els.input.focus();
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value;
  els.input.value = "";
  autoGrow();
  sendMessage(text);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${els.input.scrollHeight}px`;
}
els.input.addEventListener("input", autoGrow);

els.newChat.addEventListener("click", () => {
  if (busy) return;
  history = [];
  save();
  renderAll();
  setMeter(0);
});

document.querySelectorAll(".suggestions button").forEach((b) =>
  b.addEventListener("click", () => sendMessage(b.textContent)),
);

els.messages.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const code = btn.closest(".codeblock").querySelector("code").textContent;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
});

renderAll();
