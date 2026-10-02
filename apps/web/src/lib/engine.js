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
  { id: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 Coder 7B', size: '≈5.1 GB', note: 'Smartest — needs a good GPU' },
  { id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 Coder 3B', size: '≈2.5 GB', note: 'Balanced — recommended' },
  { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 Coder 1.5B', size: '≈1.6 GB', note: 'Fast, for most laptops' },
  { id: 'Qwen3-4B-q4f16_1-MLC', label: 'Qwen 3 4B', size: '≈3.4 GB', note: 'Reasoning model' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B', size: '≈2.3 GB', note: 'General purpose' },
];

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
      await webllmEngine.reload(model, { context_window_size: 8192 });
    } else {
      webllmEngine = await webllm.CreateMLCEngine(model, { initProgressCallback: onProgress }, { context_window_size: 8192 });
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
      const chunks = await engine.chat.completions.create({ messages, stream: true, temperature: options.temperature ?? 0.2, stream_options: { include_usage: true } });
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
    return true;
  } catch (e) {
    useStore.setState({ engine: { status: 'down', models: [], version: '', error: e.message } });
    return false;
  }
}

// ───────── Workspaces ─────────
export async function initWorkspace() {
  const server = await probeServer();
  useStore.setState({ server });
  if (server) {
    const info = await api('/api/workspace');
    publishWorkspace(serverWorkspace(info));
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
  publishWorkspace(serverWorkspace(info));
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
