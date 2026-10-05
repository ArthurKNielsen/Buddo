// Buddo chat UI. The model itself runs in worker.js, on this device.

const STORAGE_KEY = "buddo-local-chat";
const CONTEXT_LIMIT = 20000; // tokens: prompt + chat history + reply
const MAX_NEW_TOKENS = 384;
const TEMPERATURE = 0.7;

const els = {
  chat: document.getElementById("chat"),
  messages: document.getElementById("messages"),
  empty: document.getElementById("empty"),
  loading: document.getElementById("loading"),
  loadingText: document.getElementById("loading-text"),
  form: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  newChat: document.getElementById("new-chat"),
  meterFill: document.getElementById("meter-fill"),
  meterText: document.getElementById("meter-text"),
};

let history = load();
let busy = false;
let ready = false;
let onWorkerMessage = null;

// ---------- the model ----------

const worker = new Worker("worker.js");
worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "ready") {
    ready = true;
    els.loading.hidden = true;
    els.input.disabled = false;
    els.send.disabled = false;
    renderAll();
  } else if (msg.type === "error" && !ready) {
    els.loadingText.textContent = `Couldn't load Buddo: ${msg.message}. Check your connection and reload.`;
    els.loading.querySelector(".spinner").hidden = true;
  } else if (onWorkerMessage) {
    onWorkerMessage(msg);
  }
};
worker.postMessage({ type: "load", modelUrl: "buddo-model.bin", tokenizerUrl: "tokenizer.json" });

// ---------- tiny markdown-ish renderer ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Buddo answers in plain Python, so anything code-shaped goes in a code block.
function looksLikeCode(text) {
  return /^\s*(def |class |async def |@|import |from |if |for |while |return |#)/m.test(text) || /[(){}\[\]=:]\s*$/m.test(text);
}

function renderReply(text) {
  if (!text) return "";
  if (!looksLikeCode(text)) return `<div class="plain">${escapeHtml(text)}</div>`;
  return (
    `<div class="codeblock"><header><span>python</span><button type="button" data-copy>Copy</button></header>` +
    `<pre><code>${escapeHtml(text)}</code></pre></div>`
  );
}

// ---------- rendering ----------

function addBubble(role, text) {
  els.empty.hidden = true;
  const row = document.createElement("div");
  row.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "assistant") bubble.innerHTML = renderReply(text);
  else bubble.textContent = text;
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
  const pct = Math.min(100, (used / CONTEXT_LIMIT) * 100);
  els.meterFill.style.width = `${pct}%`;
  els.meterFill.className = pct > 90 ? "full" : pct > 70 ? "warn" : "";
  const k = (n) => `${+(n / 1000).toFixed(1)}k`;
  els.meterText.textContent = `${k(used)} / ${k(CONTEXT_LIMIT)}`;
}

function renderAll() {
  els.messages.innerHTML = "";
  els.empty.hidden = !ready || history.length > 0;
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

// ---------- chat ----------

function setBusy(on) {
  busy = on;
  els.send.hidden = on;
  els.stop.hidden = !on;
}

function sendMessage(text) {
  text = text.trim();
  if (busy || !ready || !text) return;
  setBusy(true);
  history.push({ role: "user", content: text });
  const userRow = addBubble("user", text).parentElement;
  const bubble = addBubble("assistant", "");
  const status = document.createElement("div");
  status.className = "status cursor";
  status.textContent = "Thinking";
  bubble.appendChild(status);

  onWorkerMessage = (msg) => {
    if (msg.type === "context") {
      setMeter(msg.used);
      if (msg.dropped > 0) {
        addNote(`Hit the 20k-token limit, so Buddo forgot the oldest ${msg.dropped / 2} message(s).`);
        els.messages.appendChild(bubble.parentElement);
      }
    } else if (msg.type === "progress") {
      status.textContent = `Reading the chat… ${Math.round((msg.done / msg.total) * 100)}%`;
    } else if (msg.type === "text") {
      bubble.innerHTML = renderReply(msg.text);
      bubble.lastElementChild?.classList.add("cursor");
      scrollDown();
    } else if (msg.type === "done" || msg.type === "error") {
      onWorkerMessage = null;
      const reply = msg.type === "done" ? msg.text.trim() : "";
      if (reply) {
        bubble.innerHTML = renderReply(reply);
        history.push({ role: "assistant", content: reply });
        save();
      } else {
        history.pop(); // keep user/assistant turns alternating
        bubble.parentElement.remove();
        userRow.remove();
        if (msg.type === "error") addBubble("error", `Something broke: ${msg.message}`);
        else if (!msg.stopped) addBubble("error", "Buddo came up empty. Try describing it differently.");
        if (!msg.stopped || msg.type === "error") els.input.value = text;
      }
      setBusy(false);
      if (matchMedia("(pointer: fine)").matches) els.input.focus();
    }
  };

  worker.postMessage({
    type: "generate",
    turns: history,
    contextLimit: CONTEXT_LIMIT,
    maxNew: MAX_NEW_TOKENS,
    temperature: TEMPERATURE,
  });
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value;
  els.input.value = "";
  autoGrow();
  sendMessage(text);
});

els.stop.addEventListener("click", () => worker.postMessage({ type: "stop" }));

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && matchMedia("(pointer: fine)").matches) {
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
  worker.postMessage({ type: "reset" });
  renderAll();
  setMeter(0);
});

document.querySelectorAll(".suggestions button").forEach((b) =>
  b.addEventListener("click", () => sendMessage(b.textContent)),
);

els.messages.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const code = btn.closest(".codeblock").querySelector("code");
  const done = (label) => {
    btn.textContent = label;
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  };
  navigator.clipboard
    .writeText(code.textContent)
    .then(() => done("Copied!"))
    .catch(() => {
      // Clipboard blocked: select the code so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      done("Selected");
    });
});

renderAll();
