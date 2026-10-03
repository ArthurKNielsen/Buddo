import { runAgent, gatherContext, parseSlash, COMPACT_PROMPT, contextTokens, locateSnippet, learnAboutUser, VIBES } from '@buddo/core';
import { useStore, uid } from './store.js';
import { getProvider, getWorkspace, currentModel, refreshFileIndex, checkEngine, liteMode, isMobile, thinkAloud } from './engine.js';
import { api } from './workspaces.js';

const S = () => useStore.getState();

const MEDIA_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|mp3|wav|m4a|aac|flac|ogg|opus|png|jpe?g|gif|webp|bmp|heic|avif)$/i;

async function expandMentions(text, ws) {
  const mentions = [...new Set([...text.matchAll(/(?:^|\s)@([\w./-]+)/g)].map((m) => m[1]))];
  let extra = '';
  for (const f of mentions.slice(0, 10)) {
    if (MEDIA_EXT.test(f)) {
      extra += `\n\n(${f} is a media file — use watch_video, listen_audio or view_image to perceive it.)`;
      continue;
    }
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
      case 'memory':
        return st.setUI({ settings: true, settingsTab: 'personality' });
      case 'vibe': {
        const v = arg.toLowerCase();
        if (VIBES[v]) {
          st.setProfile({ vibe: v });
          return st.toast(`Vibe: ${VIBES[v].emoji} ${VIBES[v].label}`, 'success');
        }
        return st.setUI({ settings: true, settingsTab: 'personality' });
      }
    }
    if (cmd.prompt) {
      if (cmd.arg && !arg && ['plan', 'fix', 'scaffold', 'watch'].includes(cmd.name)) return st.toast(`Usage: /${cmd.name} <${cmd.arg}>`);
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
  for (const a of attachments) if (!a.image) full += `\n\n<file path="${a.name}">\n${a.content.slice(0, 60000)}\n</file>`;
  const pics = attachments.filter((a) => a.image);
  const vision = st.vision;
  const lite = liteMode(settings);
  for (const a of pics) {
    if (vision) full += `\n\n[Attached image: ${a.name}]`;
    else if (st.server) {
      try {
        const d = await api('/api/media/describe', { method: 'POST', body: { name: a.name, data: a.image } });
        full += `\n\n[Attached image: ${a.name} — your model can't see images, so here is what Buddo detected]\n${d.text}`;
      } catch {
        full += `\n\n[Attached image: ${a.name} — could not be analyzed]`;
      }
    } else full += `\n\n[Attached image: ${a.name} — your current model can't see images. Suggest a vision model like qwen2.5vl.]`;
  }

  const userItem = {
    id: uid(),
    type: 'user',
    text: display || prompt,
    attachments: attachments.filter((a) => !a.image).map((a) => a.name),
    images: pics.map((a) => `data:${a.mime || 'image/jpeg'};base64,${a.image}`),
    at: Date.now(),
  };
  const draft = { id: uid(), type: 'assistant', parts: [], status: 'streaming', startedAt: Date.now(), model, mode: mode || settings.mode };
  st.patchSession(sid, (s) => ({
    items: hidden ? [...s.items, draft] : [...s.items, userItem, draft],
    title: s.title === 'New chat' && !hidden ? (display || prompt).replace(/\s+/g, ' ').slice(0, 48) : s.title,
  }));

  const history = [
    ...(S().sessions.find((x) => x.id === sid)?.history || []),
    { role: 'user', content: full, ...(vision && pics.length ? { images: pics.map((a) => a.image) } : {}) },
  ];
  const ctrl = new AbortController();
  useStore.setState({ running: { sessionId: sid, ctrl } });

  // Batch UI updates to one per animation frame.
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    S().updateItem(sid, draft.id, { ...draft, parts: draft.parts.map((p) => ({ ...p })), steps: draft.steps?.map((x) => ({ ...x })) });
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  };
  const last = () => draft.parts[draft.parts.length - 1];
  let shownPreview = false;
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
    contextBudget: lite ? 4096 : settings.engine === 'webllm' ? 8192 : settings.ctx,
    vision,
    lite,
    thinkAloud: thinkAloud(settings),
    profile: st.profile,
    temperature: settings.temperature,
    context,
    onEvent: (e) => {
      const step = draft.steps?.[draft.steps.length - 1];
      switch (e.type) {
        case 'step':
          draft.steps = [...(draft.steps || []), { n: e.step + 1, startedAt: Date.now(), promptTokens: e.promptTokens, after: e.after, raw: '' }];
          draft.phase = { kind: 'reading', tokens: e.promptTokens, after: e.after, at: Date.now() };
          break;
        case 'raw':
          if (step) {
            step.firstAt ??= Date.now();
            if (e.thinking) step.thought = (step.thought || '') + e.delta;
            else step.raw += e.delta;
          }
          if (draft.phase?.kind === 'reading') draft.phase = { kind: 'writing', at: Date.now() };
          break;
        case 'permission':
          draft.phase = { kind: 'waiting', at: Date.now() };
          break;
        case 'thinking':
          if (last()?.type === 'thinking' && !last().done) last().text += e.delta;
          else draft.parts.push({ type: 'thinking', text: e.delta, startedAt: Date.now() });
          break;
        case 'text':
          if (last()?.type === 'thinking') Object.assign(last(), { done: true, endedAt: Date.now() });
          if (last()?.type === 'text') last().text += e.delta;
          else draft.parts.push({ type: 'text', text: e.delta });
          break;
        case 'tool-stream':
          if (!S().settings.liveCode) break;
          if (last()?.type === 'thinking') Object.assign(last(), { done: true, endedAt: Date.now() });
          draft.live = { name: e.name, args: e.args, writing: e.writing, startedAt: draft.live?.name === e.name ? draft.live.startedAt : Date.now() };
          break;
        case 'tool-preparing':
          if (last()?.type === 'thinking') Object.assign(last(), { done: true, endedAt: Date.now() });
          draft.preparing = e.name;
          break;
        case 'tool-start':
          if (step && !step.endedAt) step.endedAt = Date.now();
          if (step && !e.call.auto) step.tool = e.call.name;
          draft.phase = { kind: 'tool', name: e.call.name, at: Date.now() };
          draft.preparing = null;
          draft.live = null;
          if (last()?.type === 'thinking') Object.assign(last(), { done: true, endedAt: Date.now() });
          draft.parts.push({ type: 'tool', call: e.call, kind: e.kind, status: 'running', startedAt: Date.now() });
          break;
        case 'tool-end': {
          const p = toolPart(e.id);
          if (p) Object.assign(p, { status: e.denied ? 'denied' : e.ok ? 'done' : 'error', output: e.output, display: e.display, endedAt: Date.now(), preview: undefined });
          if (p?.kind === 'write') refreshFileIndex();
          if (p?.kind === 'write' && e.ok && !shownPreview && /\.html?$/i.test(p.call.args?.path || '')) {
            shownPreview = true;
            if (isMobile()) S().toast(`Saved ${p.call.args.path} — open the panel to preview it`, 'success');
            else S().openPanel('preview');
          }
          break;
        }
        case 'nudge':
          draft.parts.push({ type: 'note', text: e.text });
          break;
        case 'usage':
          draft.usage = { prompt: e.prompt, completion: e.completion, tps: e.tps };
          if (step) Object.assign(step, { endedAt: Date.now(), usage: { prompt: e.prompt, completion: e.completion, tps: e.tps } });
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
      onRemember: (fact) => {
        const ok = S().remember(fact, 'chat');
        if (ok) S().toast(`🧠 Remembered: ${fact}`, 'success');
        return ok;
      },
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
  draft.live = null;
  for (const p of draft.parts) if (p.type === 'thinking' && !p.done) Object.assign(p, { done: true, endedAt: Date.now() });
  // Keep the activity log, but cap what gets saved with the chat.
  draft.phase = null;
  for (const x of draft.steps || []) {
    x.endedAt ??= Date.now();
    if (x.raw.length > 12000) x.raw = x.raw.slice(0, 6000) + '\n…\n' + x.raw.slice(-6000);
    if (x.thought?.length > 8000) x.thought = x.thought.slice(0, 4000) + '\n…\n' + x.thought.slice(-4000);
  }
  flush();
  S().patchSession(sid, { history: result.messages });
  useStore.setState({ running: null, permission: null });
  if (result.status === 'done' && !hidden) autoLearn(sid, { lite, settings });
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

/** Quietly ask the model what it learned about the user from their recent messages. */
async function autoLearn(sid, { lite, settings }) {
  const st = S();
  if (!st.profile.learn || lite || st.running) return;
  const session = st.sessions.find((x) => x.id === sid);
  if (!session) return;
  const userTexts = session.items.slice(session.learnedUpTo || 0).filter((i) => i.type === 'user').map((i) => i.text);
  S().patchSession(sid, { learnedUpTo: session.items.length });
  if (!userTexts.length) return;
  try {
    const facts = await learnAboutUser({ provider: getProvider(settings), model: currentModel(settings), profile: st.profile, userTexts });
    const added = facts.filter((f) => S().remember(f, 'auto'));
    if (added.length) S().toast(`🧠 Buddo learned ${added.length === 1 ? `: ${added[0]}` : `${added.length} new things about you`}`, 'success');
  } catch {}
}
