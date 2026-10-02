import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const DEFAULT_SETTINGS = {
  engine: 'ollama', // ollama | openai | webllm
  ollamaUrl: 'http://localhost:11434',
  openaiUrl: 'http://localhost:1234/v1',
  model: '',
  webllmModel: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',
  mode: 'ask',
  ctx: 16384,
  temperature: 0.2,
  theme: 'dark',
  accent: 'violet',
  showThinking: true,
  sandboxName: 'sandbox',
  onboarded: false,
};

export const newSession = () => ({
  id: uid(),
  title: 'New chat',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  history: [], // model-facing messages
  items: [], // UI timeline
  todos: [],
  changes: [], // [{path, original, current, edits, reverted}]
  terminal: [], // [{id, command, output, code, source, at}]
});

const safeStorage = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // Storage full: drop the oldest sessions and try once more.
      try {
        const parsed = JSON.parse(v);
        parsed.state.sessions = parsed.state.sessions.slice(0, 8);
        localStorage.setItem(k, JSON.stringify(parsed));
      } catch {}
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

const clipStr = (s, n = 60000) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);

function slimSession(s) {
  return {
    ...s,
    history: s.history.map((m) => (m.images ? { role: m.role, content: m.content + '\n[image omitted]' } : m)),
    items: s.items.slice(-300).map((it) =>
      it.type !== 'assistant'
        ? { ...it, images: undefined }
        : {
            ...it,
            parts: it.parts.map((p) =>
              p.type !== 'tool' ? p : { ...p, output: clipStr(p.output, 8000), preview: undefined, display: p.display && slimDisplay(p.display) },
            ),
          },
    ),
    terminal: s.terminal.slice(-60).map((t) => ({ ...t, output: clipStr(t.output, 8000) })),
  };
}
function slimDisplay(d) {
  const o = { ...d, sheet: undefined, image: undefined };
  for (const k of ['before', 'after', 'content', 'output', 'text']) if (typeof o[k] === 'string') o[k] = clipStr(o[k], 40000);
  if (o.entries) o.entries = o.entries.slice(0, 300);
  if (o.hits) o.hits = o.hits.slice(0, 120);
  if (o.files) o.files = o.files.slice(0, 300);
  return o;
}

export const useStore = create(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      sessions: [],
      activeId: null,

      // transient
      server: null, // null = unknown, false = none, {…} = info
      ws: null, // { kind, name, root, exec }
      engine: { status: 'unknown', error: '', models: [], version: '' },
      running: null, // { sessionId, ctrl }
      permission: null, // { sessionId, callId, resolve }
      webllm: null, // { text, progress }
      ui: {
        sidebar: true,
        panel: false,
        tab: 'files',
        palette: false,
        settings: false,
        settingsTab: 'engine',
        setup: false,
        folder: false,
        models: false,
        help: false,
        viewing: null,
      },
      toasts: [],
      fileIndex: [],
      composerInsert: null,
      vision: false,

      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      setUI: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
      toggleUI: (k) => set((s) => ({ ui: { ...s.ui, [k]: !s.ui[k] } })),
      openPanel: (tab) => set((s) => ({ ui: { ...s.ui, panel: true, tab } })),

      toast: (text, kind = 'info') => {
        const id = uid();
        set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
        setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3800);
      },

      activeSession: () => get().sessions.find((x) => x.id === get().activeId) || null,
      ensureSession: () => {
        let s = get().activeSession();
        if (!s) {
          s = newSession();
          set((st) => ({ sessions: [s, ...st.sessions], activeId: s.id }));
        }
        return s;
      },
      newChat: () => {
        const cur = get().activeSession();
        if (cur && !cur.items.length) return cur;
        const s = newSession();
        set((st) => ({ sessions: [s, ...st.sessions], activeId: s.id }));
        return s;
      },
      selectSession: (id) => set({ activeId: id }),
      deleteSession: (id) =>
        set((st) => {
          const sessions = st.sessions.filter((x) => x.id !== id);
          return { sessions, activeId: st.activeId === id ? sessions[0]?.id || null : st.activeId };
        }),
      renameSession: (id, title) => get().patchSession(id, { title }),
      patchSession: (id, patch) =>
        set((st) => ({
          sessions: st.sessions.map((x) => (x.id === id ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch), updatedAt: Date.now() } : x)),
        })),
      updateItem: (sid, itemId, item) =>
        set((st) => ({
          sessions: st.sessions.map((x) => (x.id === sid ? { ...x, items: x.items.map((it) => (it.id === itemId ? item : it)) } : x)),
        })),
    }),
    {
      name: 'buddo-store',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({
        settings: s.settings,
        activeId: s.activeId,
        sessions: s.sessions.slice(0, 40).map(slimSession),
        ui: { sidebar: s.ui.sidebar, tab: s.ui.tab },
      }),
      merge: (persisted, current) => ({
        ...current,
        ...persisted,
        settings: { ...DEFAULT_SETTINGS, ...(persisted?.settings || {}) },
        ui: { ...current.ui, ...(persisted?.ui || {}) },
        // Any assistant message left "streaming" from a closed tab is finished.
        sessions: (persisted?.sessions || []).map((s) => ({
          ...newSession(),
          ...s,
          items: (s.items || []).map((it) => (it.status === 'streaming' ? { ...it, status: 'stopped' } : it)),
        })),
      }),
    },
  ),
);
