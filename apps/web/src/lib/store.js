import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULT_PROFILE, normalizeProfile, addMemory } from '@buddo/core';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const DEFAULT_SETTINGS = {
  engine: 'ollama', // ollama | openai | webllm
  ollamaUrl: 'http://localhost:11434',
  openaiUrl: 'http://localhost:1234/v1',
  model: '',
  webllmModel: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',
  webllmPrecision: 'auto', // auto | f16 | f32 — GPU math for in-browser models
  webllmDevice: 'auto', // auto | gpu | cpu — where in-browser models run
  gpuBroken: false, // set when this GPU failed the correctness check even in f32
  liveCode: true, // show code while Buddo is writing it
  lite: 'auto', // auto | on | off — short prompt + small context for tiny models
  mode: 'ask',
  ctx: 16384,
  temperature: 0.2,
  skin: 'studio', // see lib/skins.js
  buddy: true, // Buddo stands on the chat bar
  theme: 'dark',
  accent: 'violet',
  showThinking: true,
  thinkAloud: 'auto', // auto | on | off — ask models without a thinking mode to think out loud
  showActivity: false, // keep the live "what the model is writing" console open
  sandboxName: 'sandbox',
  onboarded: false,
};

export const newSession = (id = uid()) => ({
  id,
  sandboxDir: `chats/${id}`, // this chat's own folder in the browser sandbox
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
      profile: DEFAULT_PROFILE,
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
      previewPath: null, // the HTML page the Preview shows (the one Buddo saved last)
      composerInsert: null,
      vision: false,

      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      setProfile: (patch) => set((s) => ({ profile: normalizeProfile({ ...s.profile, ...(typeof patch === 'function' ? patch(s.profile) : patch) }) })),
      /** Returns false if Buddo already knew it. */
      remember: (text, source = 'chat') => {
        const next = addMemory(get().profile, text, source);
        if (!next) return false;
        set({ profile: next });
        return true;
      },
      forget: (id) => set((s) => ({ profile: { ...s.profile, memories: s.profile.memories.filter((m) => m.id !== id) } })),
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
        profile: s.profile,
        activeId: s.activeId,
        sessions: s.sessions.slice(0, 40).map(slimSession),
        ui: { sidebar: s.ui.sidebar, tab: s.ui.tab },
      }),
      merge: (persisted, current) => ({
        ...current,
        ...persisted,
        settings: { ...DEFAULT_SETTINGS, ...(persisted?.settings || {}) },
        profile: normalizeProfile(persisted?.profile),
        ui: { ...current.ui, ...(persisted?.ui || {}) },
        // Any assistant message left "streaming" from a closed tab is finished.
        sessions: (persisted?.sessions || []).map((s) => ({
          ...newSession(),
          ...s,
          // Chats from before per-chat folders keep the shared sandbox files they were made with.
          sandboxDir: s.sandboxDir ?? '',
          items: (s.items || []).map((it) => (it.status === 'streaming' ? { ...it, status: 'stopped' } : it)),
        })),
      }),
    },
  ),
);
