import { applyReply } from "./edits.js";
import { hasModelInCache, loadEngine, streamReply } from "./engine.js";
import { MODELS, detectDevice, mlcId, modelRecord } from "./models.js";
import { buildPreview, pagesOf, resolvePath } from "./preview.js";
import { buildMessages, proseOf, retryMessage, tokens } from "./prompt.js";
import { deleteProject, listProjects, newProject, saveProject } from "./store.js";
import { makeZip } from "./zip.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const MAX_RETRIES = 2;
const PREF_KEY = "buddo-agent-model";

const state = {
  projects: [],
  project: null,
  device: null,
  model: null, // entry from MODELS
  engine: null,
  loading: false,
  busy: false,
  page: "index.html",
  file: null,
  lastChanged: {}, // path -> Set of changed line numbers (for highlighting)
};

// ---------- projects ----------

async function boot() {
  state.projects = await listProjects();
  if (!state.projects.length) {
    const p = newProject();
    await saveProject(p);
    state.projects = [p];
  }
  state.project = state.projects[0];
  renderProjects();
  renderAll();
  initModel();
}

function renderProjects() {
  const sel = $("project-select");
  sel.innerHTML = "";
  for (const p of state.projects) {
    const o = el("option", null, p.name);
    o.value = p.id;
    sel.append(o);
  }
  sel.value = state.project.id;
}

async function persist() {
  await saveProject(state.project);
}

$("project-select").addEventListener("change", (e) => {
  if (state.busy) return (e.target.value = state.project.id);
  state.project = state.projects.find((p) => p.id === e.target.value);
  state.lastChanged = {};
  state.file = null;
  state.page = "index.html";
  renderAll();
});

$("project-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("project-menu").hidden = !$("project-menu").hidden;
});
document.addEventListener("click", () => ($("project-menu").hidden = true));

$("project-menu").addEventListener("click", async (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (!action || state.busy) return;
  if (action === "new") {
    const p = newProject(`Project ${state.projects.length + 1}`);
    await saveProject(p);
    state.projects.unshift(p);
    state.project = p;
    state.lastChanged = {};
    state.file = null;
  } else if (action === "rename") {
    const name = await ask("Rename project", state.project.name);
    if (name) {
      state.project.name = name;
      await persist();
    }
  } else if (action === "download") {
    const blob = makeZip(state.project.files);
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.project.name.replace(/[^\w-]+/g, "-") || "project"}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } else if (action === "delete") {
    if (!(await confirmBox(`Delete "${state.project.name}"? This can't be undone.`))) return;
    await deleteProject(state.project.id);
    state.projects = state.projects.filter((p) => p.id !== state.project.id);
    if (!state.projects.length) {
      const p = newProject();
      await saveProject(p);
      state.projects = [p];
    }
    state.project = state.projects[0];
  }
  renderProjects();
  renderAll();
});

// Small in-page dialogs (no browser prompt/confirm).
function ask(title, value) {
  return new Promise((resolve) => {
    const d = el("dialog", "sheet");
    d.innerHTML = `<form method="dialog" class="sheet-body"><h2></h2><input id="ask-input" style="font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--panel-2);color:var(--text)"><div class="sheet-actions"><button value="" class="ghost">Cancel</button><button value="ok" class="primary">Save</button></div></form>`;
    d.querySelector("h2").textContent = title;
    const input = d.querySelector("input");
    input.value = value;
    d.addEventListener("close", () => {
      resolve(d.returnValue === "ok" ? input.value.trim() : null);
      d.remove();
    });
    document.body.append(d);
    d.showModal();
  });
}
function confirmBox(text) {
  return new Promise((resolve) => {
    const d = el("dialog", "sheet");
    d.innerHTML = `<form method="dialog" class="sheet-body"><p></p><div class="sheet-actions"><button value="" class="ghost">Cancel</button><button value="ok" class="primary">Delete</button></div></form>`;
    d.querySelector("p").textContent = text;
    d.addEventListener("close", () => {
      resolve(d.returnValue === "ok");
      d.remove();
    });
    document.body.append(d);
    d.showModal();
  });
}

// ---------- tabs ----------

for (const b of document.querySelectorAll("#tabs [data-tab]")) {
  b.addEventListener("click", () => setTab(b.dataset.tab));
}
function setTab(tab) {
  $("layout").dataset.tab = tab;
  for (const b of document.querySelectorAll("#tabs [data-tab]")) b.setAttribute("aria-selected", b.dataset.tab === tab);
  if (tab !== "chat") setSide(tab);
}
for (const b of document.querySelectorAll(".side-tabs [data-side]")) {
  b.addEventListener("click", () => setSide(b.dataset.side));
}
function setSide(side) {
  for (const b of document.querySelectorAll(".side-tabs [data-side]")) b.setAttribute("aria-selected", b.dataset.side === side);
  for (const p of document.querySelectorAll("[data-side-panel]")) p.hidden = p.dataset.sidePanel !== side;
  if (side === "preview") renderPreview();
}

// ---------- rendering ----------

function renderAll() {
  renderMessages();
  renderFiles();
  renderPreview();
}

function renderMessages() {
  const box = $("messages");
  box.innerHTML = "";
  if (!state.project.messages.length) box.append(welcome());
  for (const m of state.project.messages) box.append(messageEl(m));
  box.scrollTop = box.scrollHeight;
}

function welcome() {
  const w = el("div", "welcome");
  w.append(el("h1", null, "What should we build?"), el("p", null, "Buddo writes the code, shows a live preview, and when you ask for changes it only edits the lines that need to change."));
  if (!state.engine) w.append(loadCard());
  const ideas = el("div", "ideas");
  for (const idea of [
    "Make a landing page for a pizza place with a menu and a contact form",
    "Build a to-do list app that saves tasks in the browser",
    "Create a simple snake game",
  ]) {
    const b = el("button", null, idea);
    b.type = "button";
    b.addEventListener("click", () => send(idea));
    ideas.append(b);
  }
  w.append(ideas);
  return w;
}

function loadCard() {
  const c = el("div", "load-card");
  c.id = "load-card";
  const title = el("b", null, "");
  const text = el("p", "muted small", "");
  const bar = el("div", "progress");
  bar.append(el("div"));
  const btn = el("button", "primary", "");
  btn.type = "button";
  btn.addEventListener("click", () => startLoad());
  c.append(title, text, bar, btn);
  updateLoadCard();
  return c;
}

function updateLoadCard(progress) {
  const c = $("load-card");
  if (!c) return;
  const [title, text, bar, btn] = c.children;
  const d = state.device;
  bar.hidden = !state.loading;
  btn.hidden = state.loading || !d?.ok;
  if (d && !d.ok) {
    title.textContent = "This browser can't run Buddo";
    text.textContent = "Buddo needs WebGPU to run its AI on your device. Use Chrome or Edge on a computer or Android phone, or Safari on iPhone with iOS 26 or newer.";
    return;
  }
  const m = state.model;
  if (!m) {
    title.textContent = "Checking your device…";
    text.textContent = "";
    return;
  }
  if (state.loading) {
    title.textContent = `Loading ${m.label}…`;
    text.textContent = progress?.text || "Starting…";
    bar.firstChild.style.width = `${Math.round((progress?.progress || 0) * 100)}%`;
    return;
  }
  title.textContent = `Brain: ${m.label}`;
  text.textContent = state.modelSaved
    ? "Already saved on this device, so it loads in seconds."
    : `One-time download of about ${m.gb} GB. After that it's saved on this device and opens instantly, even offline.`;
  btn.textContent = state.modelSaved ? "Start" : `Download (${m.gb} GB, once)`;
}

function messageEl(m) {
  const wrap = el("div", `msg ${m.role}`);
  if (m.role === "user") {
    wrap.append(el("div", "bubble", m.content));
    return wrap;
  }
  if (m.prose) wrap.append(el("div", "prose", m.prose));
  for (const c of m.changes || []) wrap.append(changeEl(c));
  for (const e of m.errors || []) wrap.append(el("div", "note warn", e));
  if (m.note) wrap.append(el("div", "note", m.note));
  if (m.undo && Object.keys(m.undo).length) {
    const row = el("div", "turn-actions");
    const b = el("button", "link-btn", m.undone ? "Redo these changes" : "Undo these changes");
    b.type = "button";
    b.addEventListener("click", () => toggleUndo(m));
    row.append(b);
    wrap.append(row);
  }
  return wrap;
}

function changeEl(c) {
  const d = el("details", "change");
  const s = el("summary");
  s.append(el("span", null, c.kind === "create" ? "＋" : "✎"), el("span", "path", c.path));
  const end = c.startLine + Math.max(c.added.length, 1) - 1;
  s.append(el("span", "where", c.kind === "create" ? "new file" : c.added.length ? `lines ${c.startLine}–${end}` : `line ${c.startLine}`));
  const counts = el("span", "counts");
  counts.append(el("span", "plus", `+${c.added.length}`), " ", el("span", "minus", `−${c.removed.length}`));
  s.append(counts);
  const pre = el("pre", "diff");
  const MAX = 400;
  const rows = [...c.removed.map((t) => ["del", "−", t]), ...c.added.map((t) => ["add", "+", t])];
  rows.slice(0, MAX).forEach(([cls, sign, t]) => {
    const line = el("div", cls);
    line.append(el("span", "ln", sign), t);
    pre.append(line);
  });
  if (rows.length > MAX) pre.append(el("div", null, `… ${rows.length - MAX} more lines`));
  d.append(s, pre);
  return d;
}

async function toggleUndo(m) {
  if (state.busy) return;
  const swap = {};
  for (const [path, content] of Object.entries(m.undo)) {
    swap[path] = state.project.files[path] ?? null;
    if (content === null) delete state.project.files[path];
    else state.project.files[path] = content;
  }
  m.undo = swap;
  m.undone = !m.undone;
  state.lastChanged = {};
  await persist();
  renderAll();
}

// ---------- files ----------

function renderFiles() {
  const list = $("file-list");
  list.innerHTML = "";
  const paths = Object.keys(state.project.files).sort();
  if (!state.file || !(state.file in state.project.files)) state.file = paths.find((p) => state.lastChanged[p]) || paths[0] || null;
  for (const p of paths) {
    const li = el("li");
    const b = el("button", null, p);
    b.type = "button";
    if (p === state.file) b.setAttribute("aria-current", "true");
    if (state.lastChanged[p]) b.append(el("span", "badge", "●"));
    b.addEventListener("click", () => {
      state.file = p;
      renderFiles();
    });
    li.append(b);
    list.append(li);
  }
  const code = $("file-code");
  code.innerHTML = "";
  if (!state.file) {
    $("file-name").textContent = "No files yet";
    $("file-meta").textContent = "";
    return;
  }
  const text = state.project.files[state.file];
  const lines = text.split("\n");
  $("file-name").textContent = state.file;
  $("file-meta").textContent = ` · ${lines.length} lines`;
  const changed = state.lastChanged[state.file] || new Set();
  const frag = document.createDocumentFragment();
  let firstChanged = null;
  lines.forEach((t, i) => {
    const row = el("div", changed.has(i + 1) ? "changed" : null);
    row.append(el("span", "ln", String(i + 1)), t);
    if (changed.has(i + 1) && !firstChanged) firstChanged = row;
    frag.append(row);
  });
  code.append(frag);
  if (firstChanged) requestAnimationFrame(() => firstChanged.scrollIntoView({ block: "center" }));
}

// ---------- preview ----------

function renderPreview() {
  const pages = pagesOf(state.project.files);
  const sel = $("page-select");
  sel.innerHTML = "";
  for (const p of pages) {
    const o = el("option", null, p);
    o.value = p;
    sel.append(o);
  }
  if (!pages.includes(state.page)) state.page = pages[0];
  if (state.page) sel.value = state.page;
  sel.disabled = !pages.length;
  $("preview-frame").srcdoc = buildPreview(state.project.files, state.page);
}
$("page-select").addEventListener("change", (e) => {
  state.page = e.target.value;
  renderPreview();
});
$("reload-preview").addEventListener("click", renderPreview);
window.addEventListener("message", (e) => {
  if (e.source !== $("preview-frame").contentWindow || !e.data?.buddoNavigate) return;
  const target = resolvePath(e.data.from, e.data.buddoNavigate);
  if (target && target in state.project.files) {
    state.page = target;
    renderPreview();
  }
});

// ---------- model ----------

async function initModel() {
  state.device = await detectDevice();
  if (!state.device.ok) {
    $("model-label").textContent = "Not supported";
    updateLoadCard();
    return;
  }
  let key = state.device.defaultKey;
  try {
    key = localStorage.getItem(PREF_KEY) || key;
  } catch {}
  await chooseModel(MODELS.find((m) => m.key === key) || MODELS[1]);
  // Saved on this device already: load right away so chatting is instant.
  if (state.modelSaved) startLoad();
}

async function chooseModel(model) {
  state.model = model;
  try {
    localStorage.setItem(PREF_KEY, model.key);
  } catch {}
  state.modelSaved = await isSaved(model);
  $("model-label").textContent = model.label;
  updateLoadCard();
}

async function isSaved(model) {
  if (new URLSearchParams(location.search).has("mock")) return false;
  try {
    return await hasModelInCache(mlcId(model, state.device.precision), { model_list: [(await modelRecord(model, state.device.precision)).record] });
  } catch {
    return false;
  }
}

async function startLoad() {
  if (state.loading || !state.device?.ok) return;
  state.loading = true;
  state.engine = null;
  $("model-dot").className = "dot loading";
  updateLoadCard();
  try {
    const { record } = await modelRecord(state.model, state.device.precision);
    state.engine = await loadEngine(record, (p) => {
      $("model-label").textContent = `${state.model.label} · ${Math.round((p.progress || 0) * 100)}%`;
      updateLoadCard(p);
    });
    state.modelSaved = true;
    $("model-dot").className = "dot ready";
    $("model-label").textContent = state.model.label;
    $("load-card")?.remove();
    if (state.pending) {
      const text = state.pending;
      state.pending = null;
      send(text);
    }
  } catch (err) {
    $("model-dot").className = "dot";
    $("model-label").textContent = state.model.label;
    addNote(`Couldn't load ${state.model.label}: ${err.message || err}. ${state.model.key === "7B" || state.model.key === "3B" ? "Try a smaller model from the menu at the top." : ""}`, true);
  } finally {
    state.loading = false;
    updateLoadCard();
  }
}

$("model-btn").addEventListener("click", openModelSheet);
async function openModelSheet() {
  const d = state.device;
  $("device-note").textContent = !d?.ok
    ? "This browser doesn't support WebGPU, so models can't run here."
    : `${d.mobile ? "Phone" : "Computer"} detected. Recommended: ${MODELS.find((m) => m.key === d.defaultKey).label}.`;
  const list = $("model-list");
  list.innerHTML = "";
  for (const m of MODELS) {
    const row = el("label", "model-option");
    const input = el("input");
    input.type = "radio";
    input.name = "model";
    input.value = m.key;
    input.checked = state.model?.key === m.key;
    const tag = el("span", "tag", `${m.gb} GB`);
    row.append(input, el("b", null, m.label), tag, el("span", "meta", m.note));
    list.append(row);
    if (d?.ok) isSaved(m).then((saved) => saved && ((tag.textContent = "Saved"), tag.classList.add("saved")));
  }
  $("load-model").disabled = !d?.ok;
  $("model-dialog").showModal();
}
$("load-model").addEventListener("click", async () => {
  const key = $("model-list").querySelector("input:checked")?.value;
  $("model-dialog").close();
  if (!key) return;
  const model = MODELS.find((m) => m.key === key);
  if (state.engine && state.model.key === key) return;
  if (state.engine?.unload) await state.engine.unload().catch(() => {});
  state.engine = null;
  $("model-dot").className = "dot";
  await chooseModel(model);
  if (!$("load-card") && !state.project.messages.length) renderMessages();
  startLoad();
});

// ---------- the agent ----------

function addNote(text, warn = false) {
  const n = el("div", `note${warn ? " warn" : ""}`, text);
  $("messages").append(n);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function setBusy(on) {
  state.busy = on;
  $("send").hidden = on;
  $("stop").hidden = !on;
}

async function send(text) {
  text = text.trim();
  if (!text || state.busy) return;
  if (!state.engine) {
    state.pending = text;
    $("input").value = text;
    if (!state.loading) {
      if (state.device?.ok) startLoad();
      else addNote("This browser can't run Buddo. See the message above.", true);
    } else {
      addNote("Still loading the model. Your message will send as soon as it's ready.");
    }
    return;
  }
  $("input").value = "";
  autoGrow();
  setBusy(true);
  const project = state.project;
  if (!project.messages.length) $("messages").innerHTML = "";
  const userMsg = { role: "user", content: text };
  project.messages.push(userMsg);
  $("messages").append(messageEl(userMsg));

  const live = el("div", "msg assistant");
  const prose = el("div", "prose");
  const working = el("div", "working", "Thinking…");
  live.append(prose, working);
  $("messages").append(live);
  const scroll = () => ($("messages").scrollTop = $("messages").scrollHeight);
  scroll();

  const { ctx, maxReply } = state.model;
  const history = (project.history ||= []);
  let messages = buildMessages({ history, request: text, files: project.files, ctx, maxReply });
  const before = { ...project.files };
  const allChanges = [];
  let errors = [];
  let replies = [];
  let note = null;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const { text: reply, truncated } = await streamReply(state.engine, messages, {
        maxReply,
        onText: (t) => {
          prose.textContent = [...replies.map(proseOf), proseOf(t)].filter(Boolean).join("\n\n");
          const editing = (t.match(/<{5,9} ?SEARCH/g) || []).length;
          working.textContent = editing ? `Writing ${editing} edit${editing > 1 ? "s" : ""}…` : "Thinking…";
          scroll();
        },
      });
      replies.push(reply);
      const result = applyReply(project.files, reply);
      project.files = result.files;
      allChanges.push(...result.changes);
      errors = result.errors;
      if (truncated) note = "The reply hit the length limit, so it may be cut short. Ask Buddo to continue.";
      if (!errors.length || attempt === MAX_RETRIES || state.stopped) break;
      working.textContent = `Fixing ${errors.length} edit${errors.length > 1 ? "s" : ""} that didn't apply…`;
      const paths = Object.keys(project.files).filter((p) => errors.some((e) => e.includes(p)));
      messages = [...messages, { role: "assistant", content: reply }, { role: "user", content: retryMessage(errors, project.files, paths, Math.floor(ctx * 0.4)) }];
      while (messages.length > 3 && messages.reduce((n, m) => n + tokens(m.content), 0) > ctx - maxReply) messages.splice(1, 2);
    }
  } catch (err) {
    note = state.stopped ? "Stopped." : `Something went wrong: ${err.message || err}`;
  }

  // Remember which files this turn changed, so it can be undone.
  const undo = {};
  for (const c of allChanges) if (!(c.path in undo)) undo[c.path] = c.path in before ? before[c.path] : null;
  state.lastChanged = {};
  for (const c of allChanges) {
    const set = (state.lastChanged[c.path] ||= new Set());
    c.added.forEach((_, i) => set.add(c.startLine + i));
  }
  const assistantMsg = {
    role: "assistant",
    prose: replies.map(proseOf).filter(Boolean).join("\n\n"),
    changes: allChanges,
    errors: errors.length ? [`${errors.length} edit${errors.length > 1 ? "s" : ""} couldn't be applied: ${errors.join(" ")}`] : [],
    note,
    undo,
  };
  if (!assistantMsg.prose && !allChanges.length && !note) assistantMsg.note = "Buddo didn't reply. Try asking again.";
  project.messages.push(assistantMsg);
  history.push({ role: "user", content: text }, { role: "assistant", content: replies.join("\n\n") || "(no reply)" });
  if (history.length > 40) history.splice(0, history.length - 40);
  state.stopped = false;
  await persist();
  live.replaceWith(messageEl(assistantMsg));
  scroll();
  renderFiles();
  renderPreview();
  if (allChanges.length && matchMedia("(max-width: 820px)").matches === false) setSide("preview");
  setBusy(false);
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("input").value);
});
$("stop").addEventListener("click", () => {
  state.stopped = true;
  state.engine?.interruptGenerate?.();
});
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && matchMedia("(pointer: fine)").matches) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
function autoGrow() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight}px`;
}
$("input").addEventListener("input", autoGrow);

boot();
