import { runAgent, gatherContext, parseSlash, COMPACT_PROMPT, contextTokens, locateSnippet } from '@buddo/core';
import { useStore, uid } from './store.js';
import { getProvider, getWorkspace, currentModel, refreshFileIndex, checkEngine } from './engine.js';

const S = () => useStore.getState();

async function expandMentions(text, ws) {
  const mentions = [...new Set([...text.matchAll(/(?:^|\s)@([\w./-]+)/g)].map((m) => m[1]))];
  let extra = '';
  for (const f of mentions.slice(0, 10)) {
    try {
      const c = await ws.read(f);
      extra += `\n\n<file path="${f}">\n${c.slice(0, 40000)}\n</file>`;
    } catch {}
  }
  return text + extra;
}

/** Handle composer input: slash commands or a normal message. */
export async function submit(input, attachments = []) {
  const text = input.trim();
  if (!text && !attachments.length) return;
  const st = S();
  if (st.running) return;

  const slash = text.startsWith('/') ? parseSlash(text) : null;
  if (slash?.unknown) return st.toast(`Unknown command /${slash.unknown}`, 'error');
  if (slash) {
    const { cmd, arg } = slash;
    switch (cmd.action) {
      case 'help':
        return st.setUI({ help: true });
      case 'clear':
        st.newChat();
        return;
      case 'model':
        return st.setUI({ models: true });
      case 'mode': {
        const order = ['ask', 'auto', 'yolo', 'plan'];
        const next = order.includes(arg) ? arg : order[(order.indexOf(st.settings.mode) + 1) % order.length];
        st.setSettings({ mode: next });
        return st.toast(`Mode: ${next}`);
      }
      case 'compact':
        return compact();
    }
    if (cmd.prompt) {
      if (cmd.arg && !arg && ['plan', 'fix', 'scaffold'].includes(cmd.name)) return st.toast(`Usage: /${cmd.name} <${cmd.arg}>`);
      return send(cmd.prompt(arg), { display: text, mode: cmd.mode });
    }
  }
  return send(text, { attachments });
}

export async function send(prompt, { display, mode, attachments = [], hidden = false } = {}) {
  const st = S();
  const session = st.ensureSession();
  const sid = session.id;
  const ws = getWorkspace();
  const settings = st.settings;
  const model = currentModel(settings);
  if (!model) {
    st.setUI({ setup: true });
    return st.toast('Pick a model first', 'error');
  }

  let full = await expandMentions(prompt, ws);
  for (const a of attachments) full += `\n\n<file path="${a.name}">\n${a.content.slice(0, 60000)}\n</file>`;

  const userItem = { id: uid(), type: 'user', text: display || prompt, attachments: attachments.map((a) => a.name), at: Date.now() };
  const draft = { id: uid(), type: 'assistant', parts: [], status: 'streaming', startedAt: Date.now(), model, mode: mode || settings.mode };
  st.patchSession(sid, (s) => ({
    items: hidden ? [...s.items, draft] : [...s.items, userItem, draft],
    title: s.title === 'New chat' && !hidden ? (display || prompt).replace(/\s+/g, ' ').slice(0, 48) : s.title,
  }));

  const history = [...(S().sessions.find((x) => x.id === sid)?.history || []), { role: 'user', content: full }];
  const ctrl = new AbortController();
  useStore.setState({ running: { sessionId: sid, ctrl } });

  // Batch UI updates to one per animation frame.
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    S().updateItem(sid, draft.id, { ...draft, parts: draft.parts.map((p) => ({ ...p })) });
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  };
  const last = () => draft.parts[draft.parts.length - 1];
  const toolPart = (id) => draft.parts.find((p) => p.type === 'tool' && p.call.id === id);

  let context;
  try {
    context = await gatherContext(ws);
  } catch {}

  const result = await runAgent({
    provider: getProvider(settings),
    model,
    workspace: ws,
    messages: history,
    mode: mode || settings.mode,
    signal: ctrl.signal,
    contextBudget: settings.engine === 'webllm' ? 8192 : settings.ctx,
    temperature: settings.temperature,
    context,
    onEvent: (e) => {
      switch (e.type) {
        case 'thinking':
          if (last()?.type === 'thinking' && !last().done) last().text += e.delta;
          else draft.parts.push({ type: 'thinking', text: e.delta, startedAt: Date.now() });
          break;
        case 'text':
          if (last()?.type === 'thinking') Object.assign(last(), { done: true, endedAt: Date.now() });
          if (last()?.type === 'text') last().text += e.delta;
          else draft.parts.push({ type: 'text', text: e.delta });
          break;
        case 'tool-preparing':
          if (last()?.type === 'thinking') Object.assign(last(), { done: true, endedAt: Date.now() });
          draft.preparing = e.name;
          break;
        case 'tool-start':
          draft.preparing = null;
          if (last()?.type === 'thinking') Object.assign(last(), { done: true, endedAt: Date.now() });
          draft.parts.push({ type: 'tool', call: e.call, kind: e.kind, status: 'running', startedAt: Date.now() });
          break;
        case 'tool-end': {
          const p = toolPart(e.id);
          if (p) Object.assign(p, { status: e.denied ? 'denied' : e.ok ? 'done' : 'error', output: e.output, display: e.display, endedAt: Date.now(), preview: undefined });
          if (p?.kind === 'write') refreshFileIndex();
          break;
        }
        case 'usage':
          draft.usage = { prompt: e.prompt, completion: e.completion, tps: e.tps };
          break;
        case 'error':
          draft.status = 'error';
          draft.error = e.error;
          break;
        case 'stopped':
          draft.status = 'stopped';
          break;
        case 'done':
          draft.status = 'done';
          break;
      }
      schedule();
    },
    askPermission: async (call) => {
      const p = toolPart(call.id);
      if (p) {
        p.status = 'awaiting';
        p.preview = await previewChange(call, ws);
        flush();
      }
      return new Promise((resolve) => {
        useStore.setState({ permission: { sessionId: sid, callId: call.id, resolve } });
        ctrl.signal.addEventListener('abort', () => resolve('deny'), { once: true });
      }).then((answer) => {
        useStore.setState({ permission: null });
        if (p) {
          p.status = answer === 'deny' ? 'denied' : 'running';
          flush();
        }
        return answer;
      });
    },
    callbacks: {
      onChange: ({ path, before, after }) =>
        S().patchSession(sid, (s) => {
          const existing = s.changes.find((c) => c.path === path && !c.reverted);
          const changes = existing
            ? s.changes.map((c) => (c === existing ? { ...c, current: after, edits: c.edits + 1, at: Date.now() } : c))
            : [{ id: uid(), path, original: before, current: after, edits: 1, at: Date.now() }, ...s.changes.filter((c) => c.path !== path)];
          return { changes };
        }),
      onTodos: (todos) => S().patchSession(sid, { todos }),
      onCommand: ({ command, output, code }) =>
        S().patchSession(sid, (s) => ({ terminal: [...s.terminal, { id: uid(), command, output, code, source: 'agent', at: Date.now() }] })),
    },
  });

  if (draft.status === 'streaming') draft.status = result.status === 'done' ? 'done' : result.status;
  draft.endedAt = Date.now();
  draft.preparing = null;
  for (const p of draft.parts) if (p.type === 'thinking' && !p.done) Object.assign(p, { done: true, endedAt: Date.now() });
  flush();
  S().patchSession(sid, { history: result.messages });
  useStore.setState({ running: null, permission: null });
  if (result.status === 'error' && /fetch|reach|ECONNREFUSED|Failed/i.test(draft.error || '')) checkEngine();
}

async function previewChange(call, ws) {
  if (call.name === 'run_command') return null;
  let before = '';
  try {
    before = await ws.read(call.args.path);
  } catch {
    before = null;
  }
  if (call.name === 'write_file') return { before, after: call.args.content ?? '' };
  if (before === null) return { before: '', after: '', missing: true };
  const m = locateSnippet(before, call.args.old || '');
  if (!m.length) return { before, after: before, notFound: true };
  let after = before;
  const ranges = /^(true|yes|1)$/i.test(call.args.all || '') ? m : [m[0]];
  for (const [s, e] of [...ranges].reverse()) after = after.slice(0, s) + (call.args.new ?? '') + after.slice(e);
  return { before, after };
}

export function respondPermission(answer) {
  S().permission?.resolve(answer);
}

export function stop() {
  const r = S().running;
  if (r) {
    r.ctrl.abort();
    S().permission?.resolve('deny');
  }
}

export async function compact() {
  const st = S();
  const s = st.activeSession();
  if (!s?.history.length) return st.toast('Nothing to compact yet');
  const before = contextTokens(s.history);
  await send(COMPACT_PROMPT, { hidden: true, mode: 'plan' });
  const after = S().activeSession();
  const summary = after.history[after.history.length - 1]?.content || '';
  const history = [
    { role: 'user', content: `Context from earlier in this session (compacted):\n${summary}` },
    { role: 'assistant', content: 'Got it — I have the full context and will continue from here.' },
  ];
  S().patchSession(s.id, (x) => ({
    history,
    items: [...x.items, { id: uid(), type: 'notice', text: `Conversation compacted · ${before.toLocaleString()} → ${contextTokens(history).toLocaleString()} tokens` }],
  }));
}

export async function revertChange(sessionId, path) {
  const ws = getWorkspace();
  const s = S().sessions.find((x) => x.id === sessionId);
  const c = s?.changes.find((x) => x.path === path && !x.reverted);
  if (!c) return;
  try {
    if (c.original === null || c.original === undefined) await ws.remove(path);
    else await ws.write(path, c.original);
    S().patchSession(sessionId, (x) => ({
      changes: x.changes.map((y) => (y === c || y.id === c.id ? { ...y, reverted: true } : y)),
      history: [...x.history, { role: 'user', content: `[Note: the user reverted your changes to ${path}. It is back to its original state.]` }, { role: 'assistant', content: 'Understood.' }],
    }));
    refreshFileIndex();
    S().toast(`Reverted ${path}`, 'success');
  } catch (e) {
    S().toast(`Revert failed: ${e.message}`, 'error');
  }
}

export async function runUserCommand(command) {
  const ws = getWorkspace();
  const st = S();
  const s = st.ensureSession();
  const id = uid();
  st.patchSession(s.id, (x) => ({ terminal: [...x.terminal, { id, command, output: '', code: null, source: 'user', at: Date.now() }] }));
  let output = '';
  const update = (patch) =>
    S().patchSession(s.id, (x) => ({ terminal: x.terminal.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  const r = await ws.run(command, {
    onData: (d) => {
      output += d;
      update({ output });
    },
  });
  update({ output: [r.stdout, r.stderr].filter(Boolean).join('\n') || output, code: r.code });
  refreshFileIndex();
}

export function retryLast() {
  const s = S().activeSession();
  if (!s || S().running) return;
  const lastUser = [...s.items].reverse().find((i) => i.type === 'user');
  if (!lastUser) return;
  // Drop the last exchange from history and timeline, then resend.
  const idx = s.items.lastIndexOf(lastUser);
  let hIdx = -1;
  for (let i = s.history.length - 1; i >= 0; i--) {
    if (s.history[i].role === 'user' && !s.history[i].content.startsWith('<tool_result')) {
      hIdx = i;
      break;
    }
  }
  S().patchSession(s.id, { items: s.items.slice(0, idx), history: hIdx >= 0 ? s.history.slice(0, hIdx) : s.history });
  submit(lastUser.text);
}
