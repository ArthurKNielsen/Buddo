// Connects the UI to a model engine and a workspace.

import { ollamaProvider, openaiCompatProvider } from '@buddo/core';
import { useStore } from './store.js';
import {
  detectServer, serverWorkspace, sandboxWorkspace, browserFolderWorkspace, api, loadHandle, saveHandle, supportsFolderAccess,
} from './workspaces.js';

let workspace = sandboxWorkspace();
let serverProbe = null;
const probeServer = () => (serverProbe ||= detectServer());
export const getWorkspace = () => workspace;

function publishWorkspace(ws) {
  workspace = ws;
  useStore.setState({ ws: { kind: ws.kind, type: ws.type, name: ws.name, root: ws.root, exec: !!ws.capabilities.exec } });
  refreshFileIndex();
}

export async function refreshFileIndex() {
  try {
    const entries = await workspace.list('.', 12);
    useStore.setState({ fileIndex: entries });
  } catch {
    useStore.setState({ fileIndex: [] });
  }
}

// ───────── WebLLM (in-browser, WebGPU) ─────────
export const WEBLLM_MODELS = [
  // Pocket models: tiny, fast enough for phones (iPhone Safari 26+ has WebGPU).
  { id: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC', label: 'Pocket Coder 0.5B', size: '≈300 MB', note: 'Fastest — made for phones ⚡', pocket: true },
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', label: 'Pocket Mini 360M', size: '≈200 MB', note: 'Ultralight chat, older phones', pocket: true },
  { id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Pocket Thinker 0.6B', size: '≈350 MB', note: 'Tiny model that reasons', pocket: true },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Pocket Plus 1B', size: '≈700 MB', note: 'Best quality under 1 GB', pocket: true },
  { id: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 Coder 7B', size: '≈5.1 GB', note: 'Smartest — needs a good GPU' },
  { id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 Coder 3B', size: '≈2.5 GB', note: 'Balanced — recommended' },
  { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 Coder 1.5B', size: '≈1.6 GB', note: 'Fast, for most laptops' },
  { id: 'Qwen3-4B-q4f16_1-MLC', label: 'Qwen 3 4B', size: '≈3.4 GB', note: 'Reasoning model' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B', size: '≈2.3 GB', note: 'General purpose' },
];

/** Tiny models (any engine) get the short "lite" prompt and a small context so they stay fast. */
export const isPocketModel = (id = '') => WEBLLM_MODELS.some((m) => m.pocket && m.id === id) || /(^|[:\-_])(0\.5b|360m|135m|0\.6b|1b|1\.1b)\b/i.test(id);
export const isMobile = () => typeof navigator !== 'undefined' && (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)));
export function liteMode(settings = useStore.getState().settings) {
  if (settings.lite === 'on') return true;
  if (settings.lite === 'off') return false;
  return isPocketModel(currentModel(settings));
}

let webllmEngine = null;
let webllmLoaded = '';
let webllmLoading = null;

export const hasWebGPU = () => typeof navigator !== 'undefined' && 'gpu' in navigator;

export async function loadWebLLM(model) {
  if (webllmEngine && webllmLoaded === model) return webllmEngine;
  if (webllmLoading) return webllmLoading;
  if (!hasWebGPU()) throw new Error('WebGPU is not available in this browser. Try Chrome or Edge, or use Ollama.');
  webllmLoading = (async () => {
    useStore.setState({ webllm: { text: 'Loading WebLLM runtime…', progress: 0 } });
    const webllm = await import(/* @vite-ignore */ 'https://esm.run/@mlc-ai/web-llm@0.2');
    const onProgress = (p) => useStore.setState({ webllm: { text: p.text, progress: p.progress } });
    if (webllmEngine) {
      webllmEngine.setInitProgressCallback?.(onProgress);
      await webllmEngine.reload(model, { context_window_size: isPocketModel(model) ? 4096 : 8192 });
    } else {
      webllmEngine = await webllm.CreateMLCEngine(model, { initProgressCallback: onProgress }, { context_window_size: isPocketModel(model) ? 4096 : 8192 });
    }
    webllmLoaded = model;
    useStore.setState({ webllm: { text: 'Ready', progress: 1, ready: true } });
    return webllmEngine;
  })();
  try {
    return await webllmLoading;
  } catch (e) {
    useStore.setState({ webllm: { text: e.message, progress: 0, error: true } });
    throw e;
  } finally {
    webllmLoading = null;
  }
}

function webllmProvider() {
  return {
    id: 'webllm',
    label: 'In-browser',
    async ping() {
      if (!hasWebGPU()) throw new Error('WebGPU not supported');
      return {};
    },
    async listModels() {
      return WEBLLM_MODELS.map((m) => ({ id: m.id, label: m.label }));
    },
    async *stream({ model, messages, signal, options = {} }) {
      const engine = await loadWebLLM(model);
      const chunks = await engine.chat.completions.create({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        temperature: options.temperature ?? 0.2,
        // Short replies keep tiny models snappy on phones.
        max_tokens: isPocketModel(model) ? 900 : 2048,
        stream_options: { include_usage: true },
      });
      for await (const c of chunks) {
        if (signal?.aborted) {
          engine.interruptGenerate();
          break;
        }
        const t = c.choices?.[0]?.delta?.content;
        if (t) yield { type: 'text', text: t };
        if (c.usage) yield { type: 'usage', prompt: c.usage.prompt_tokens, completion: c.usage.completion_tokens, tps: c.usage.extra?.decode_tokens_per_s };
      }
    },
  };
}

// ───────── Providers ─────────
export function getProvider(settings = useStore.getState().settings) {
  const server = useStore.getState().server;
  const proxy = (target) => ({ baseUrl: '/llm', headers: { 'x-buddo': '1', 'x-buddo-target': target } });
  if (settings.engine === 'webllm') return webllmProvider();
  if (settings.engine === 'openai') return openaiCompatProvider(server ? proxy(settings.openaiUrl) : { baseUrl: settings.openaiUrl });
  return ollamaProvider(server ? proxy(settings.ollamaUrl) : { baseUrl: settings.ollamaUrl });
}

/** Ask the engine whether the current model can see images. */
export async function checkVision() {
  const { settings } = useStore.getState();
  const model = currentModel(settings);
  if (!model || settings.engine === 'webllm') return useStore.setState({ vision: false });
  try {
    const info = await getProvider(settings).modelInfo?.(model);
    if (currentModel(useStore.getState().settings) === model) useStore.setState({ vision: !!info?.vision });
  } catch {
    useStore.setState({ vision: false });
  }
}

export function currentModel(settings = useStore.getState().settings) {
  return settings.engine === 'webllm' ? settings.webllmModel : settings.model;
}

export async function checkEngine() {
  if (useStore.getState().server === null) useStore.setState({ server: await probeServer() });
  const { settings, setSettings } = useStore.getState();
  const prev = useStore.getState().engine;
  useStore.setState({ engine: { ...prev, status: 'checking' } });
  try {
    const p = getProvider(settings);
    const v = await p.ping();
    const models = (await p.listModels()).filter((m) => !/embed/i.test(m.id));
    if (settings.engine !== 'webllm' && models.length && !models.some((m) => m.id === settings.model)) {
      const pref = ['qwen3-coder', 'qwen2.5-coder:14b', 'qwen2.5-coder', 'qwen3', 'gpt-oss', 'deepseek-coder', 'llama3'];
      const pick = pref.map((x) => models.find((m) => m.id.startsWith(x))).find(Boolean) || models[0];
      setSettings({ model: pick.id });
    }
    useStore.setState({ engine: { status: models.length ? 'ok' : 'empty', models, version: v?.version || '', error: '' } });
    checkVision();
    return true;
  } catch (e) {
    useStore.setState({ engine: { status: 'down', models: [], version: '', error: e.message } });
    return false;
  }
}

// ───────── Workspaces ─────────
// Personality + memories are shared with the CLI through ~/.buddo/profile.json when the local server runs.
let profileSync = null;
async function syncProfile() {
  try {
    const remote = await api('/api/profile');
    const local = useStore.getState().profile;
    const ids = new Set(remote.memories.map((m) => m.text));
    const merged = { ...remote, ...(local.memories.length || local.vibe !== 'buddy' ? local : {}), memories: [...remote.memories, ...local.memories.filter((m) => !ids.has(m.text))] };
    useStore.setState({ profile: merged });
    await api('/api/profile', { method: 'PUT', body: merged });
  } catch {}
  if (profileSync) return;
  profileSync = useStore.subscribe((s, prev) => {
    if (s.profile === prev.profile) return;
    clearTimeout(profileSync.t);
    profileSync.t = setTimeout(() => api('/api/profile', { method: 'PUT', body: useStore.getState().profile }).catch(() => {}), 400);
  });
}

// Only offer screenshot / record_video when the server has a browser to drive.
let browserOk = null;
async function makeServerWorkspace(info) {
  const ws = serverWorkspace(info);
  browserOk ??= api('/api/browser/status').then((b) => b.available).catch(() => false);
  if (!(await browserOk)) {
    delete ws.media.screenshot;
    delete ws.media.record_video;
  }
  return ws;
}

export async function initWorkspace() {
  const server = await probeServer();
  useStore.setState({ server });
  if (server) syncProfile();
  if (server) {
    const info = await api('/api/workspace');
    publishWorkspace(await makeServerWorkspace(info));
    return;
  }
  const kind = localStorage.getItem('buddo-ws-kind');
  if (kind === 'folder' && supportsFolderAccess()) {
    const handle = await loadHandle();
    if (handle && (await handle.queryPermission?.({ mode: 'readwrite' })) === 'granted') {
      publishWorkspace(browserFolderWorkspace(handle));
      return;
    }
    if (handle) useStore.setState({ pendingHandle: handle });
  }
  publishWorkspace(sandboxWorkspace(useStore.getState().settings.sandboxName));
}

export async function reconnectFolder() {
  const handle = useStore.getState().pendingHandle;
  if (!handle) return false;
  if ((await handle.requestPermission({ mode: 'readwrite' })) === 'granted') {
    publishWorkspace(browserFolderWorkspace(handle));
    useStore.setState({ pendingHandle: null });
    return true;
  }
  return false;
}

export async function openServerFolder(root) {
  const info = await api('/api/workspace', { method: 'POST', body: { root } });
  publishWorkspace(await makeServerWorkspace(info));
  localStorage.setItem('buddo-last-root', info.root);
  return info;
}

export async function pickBrowserFolder() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await saveHandle(handle);
  localStorage.setItem('buddo-ws-kind', 'folder');
  publishWorkspace(browserFolderWorkspace(handle));
}

export function useSandbox() {
  localStorage.setItem('buddo-ws-kind', 'sandbox');
  publishWorkspace(sandboxWorkspace(useStore.getState().settings.sandboxName));
}

export async function pullModel(model, onProgress, signal) {
  const p = getProvider({ ...useStore.getState().settings, engine: 'ollama' });
  for await (const ev of p.pull(model, { signal })) onProgress(ev);
  await checkEngine();
}
