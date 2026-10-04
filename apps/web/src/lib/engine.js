// Connects the UI to a model engine and a workspace.

import { ollamaProvider, openaiCompatProvider, thinksNatively, looksGarbled } from '@buddo/core';
import { useStore } from './store.js';
import { loadCpu, cpuStream, cpuSupports } from './cpu-engine.js';
import {
  detectServer, serverWorkspace, sandboxWorkspace, browserFolderWorkspace, api, loadHandle, saveHandle, supportsFolderAccess, chatSandbox,
} from './workspaces.js';

let workspace = sandboxWorkspace();
let serverProbe = null;
const probeServer = () => (serverProbe ||= detectServer());

// In the browser sandbox every chat has its own folder, so two chats never share (or overwrite) files.
// Real folders (local or opened in the browser) are one project that every chat works on.
const views = new Map();

// Browser-only workspaces edit videos with ffmpeg.wasm (loaded the first time a video tool runs).
function withBrowserMedia(ws) {
  if (ws.media || !ws.writeBinary) return ws;
  const lazy = (name) => async (args) => (await import('./browser-media.js'))[name](ws, args);
  ws.media = { edit_video: lazy('editVideo'), watch_video: lazy('watchVideo'), outputs: ['.mp4', '.gif'] };
  return ws;
}

/** The workspace a chat works in. */
export function workspaceFor(session) {
  // The desktop app's home folder: each chat gets its own folder there too, and sees nothing else.
  if (workspace.type === 'server' && workspace.info?.chatFolders) {
    // (chats from before keep working in the shared folder, where their files are)
    const id = session && !session.ownFolder ? '' : session?.id || '_new';
    if (!views.has(id)) views.set(id, withServerExtras(serverWorkspace(workspace.info, id || null)));
    return views.get(id);
  }
  if (workspace.type !== 'sandbox') return workspace;
  const dir = session ? session.sandboxDir ?? '' : 'chats/_new';
  if (!views.has(dir)) views.set(dir, withBrowserMedia(chatSandbox(workspace, dir)));
  return views.get(dir);
}
/** The workspace of the chat on screen. */
export const getWorkspace = () => workspaceFor(useStore.getState().activeSession());

// Show the right files when switching chats; drop a deleted chat's sandbox folder.
useStore.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) refreshFileIndex();
  if (s.sessions !== prev.sessions && workspace.type === 'sandbox') {
    const alive = new Set(s.sessions.map((x) => x.sandboxDir));
    for (const x of prev.sessions) if (x.sandboxDir && !alive.has(x.sandboxDir)) workspace.removeWhere((k) => k.startsWith(`${x.sandboxDir}/`));
  }
  if (s.sessions !== prev.sessions && workspace.type === 'server' && workspace.info?.chatFolders) {
    const alive = new Set(s.sessions.map((x) => x.id));
    for (const x of prev.sessions) {
      if (alive.has(x.id) || !x.ownFolder) continue;
      views.delete(x.id);
      api('/api/chat/remove', { method: 'POST', body: { chat: x.id } }).catch(() => {});
    }
  }
});

// While an in-browser model runs, the GPU is busy with it: drop the frosted-glass blurs so the page stays smooth.
if (typeof document !== 'undefined') {
  useStore.subscribe((st) => {
    document.documentElement.classList.toggle('gpu-busy', !!st.running && st.settings.engine === 'webllm' && !usesCpu(st.settings));
  });
}

function publishWorkspace(ws) {
  workspace = ws.type === 'folder' ? withBrowserMedia(ws) : ws;
  views.clear();
  useStore.setState({ ws: { kind: ws.kind, type: ws.type, name: ws.name, root: ws.root, exec: !!ws.capabilities.exec, chatFolders: ws.type === 'sandbox' || !!ws.info?.chatFolders } });
  refreshFileIndex();
}

export async function refreshFileIndex() {
  try {
    const entries = await getWorkspace().list('.', 12);
    useStore.setState({ fileIndex: entries });
  } catch {
    useStore.setState({ fileIndex: [] });
  }
}

// ───────── WebLLM (in-browser, WebGPU) ─────────
export const WEBLLM_MODELS = [
  // Pocket models: tiny, fast enough for phones (iPhone Safari 26+ has WebGPU).
  { id: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC', label: 'Pocket Coder 0.5B', size: '≈300 MB', note: 'Fastest — made for phones ⚡', uses: ['code'], best: 'Quick code edits and small pages on Chromebooks and phones', pocket: true },
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', label: 'Pocket Mini 360M', size: '≈200 MB', note: 'Ultralight chat, older phones', uses: ['chat'], best: 'Simple chat on very old devices (weak at code)', pocket: true },
  { id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Pocket Thinker 0.6B', size: '≈350 MB', note: 'Tiny model that reasons', uses: ['think', 'search'], best: 'Questions that need step-by-step thinking (thinks first, so replies take longer)', pocket: true },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Pocket Plus 1B', size: '≈700 MB', note: 'Best quality under 1 GB', uses: ['chat', 'search'], best: 'Questions, writing and web search (OK at code)', pocket: true },
  { id: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 Coder 7B', size: '≈5.1 GB', note: 'Smartest — needs a good GPU', uses: ['code'], best: 'Best code in the browser — needs a strong GPU' },
  { id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 Coder 3B', size: '≈2.5 GB', note: 'Balanced — recommended', uses: ['code'], best: 'Good code on a decent GPU' },
  { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 Coder 1.5B', size: '≈1.6 GB', note: 'Fast, for most laptops', uses: ['code'], best: 'Solid code on most laptops' },
  { id: 'Qwen3-4B-q4f16_1-MLC', label: 'Qwen 3 4B', size: '≈3.4 GB', note: 'Reasoning model', uses: ['think', 'search', 'chat'], best: 'Tricky questions, reasoning and web search' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B', size: '≈2.3 GB', note: 'General purpose', uses: ['chat', 'search'], best: 'Chat, writing and web search' },
];

/** Which model to pick for what, per device. Shown at the top of the model picker. */
export function modelGuide(settings = useStore.getState().settings) {
  if (settings.engine === 'webllm' && usesCpu(settings)) {
    return [
      { use: 'code', text: 'Coding', id: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC' },
      { use: 'search', text: 'Questions & web search', id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC' },
      { use: 'think', text: 'Step-by-step thinking (slower)', id: 'Qwen3-0.6B-q4f16_1-MLC' },
    ];
  }
  if (settings.engine === 'webllm') {
    return [
      { use: 'code', text: 'Coding (7B if your GPU is strong)', id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC' },
      { use: 'search', text: 'Questions & web search', id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC' },
      { use: 'think', text: 'Tricky questions', id: 'Qwen3-4B-q4f16_1-MLC' },
    ];
  }
  return [
    { use: 'code', text: 'Coding', id: 'qwen2.5-coder:7b' },
    { use: 'search', text: 'Questions, thinking & web search', id: 'qwen3:8b' },
    { use: 'vision', text: 'Looking at images', id: 'gemma3:4b' },
  ];
}

/** 1–4: how fast a model runs here, from its download size (smaller = faster). 0 = can't run here (needs a GPU). */
export function speedRating(m, settings = useStore.getState().settings) {
  if (settings.engine === 'webllm' && usesCpu(settings) && !cpuSupports(m.id)) return 0;
  const mb = typeof m.size === 'number' ? m.size / 1e6 : parseFloat(String(m.size).replace(/[^\d.]/g, '')) * (/GB/i.test(m.size) ? 1000 : 1);
  if (!mb) return null;
  return mb < 450 ? 4 : mb < 1000 ? 3 : mb < 2700 ? 2 : 1;
}

// Real speeds measured on this device (tokens/sec while writing), per engine + model.
export const speedKey = (model, settings = useStore.getState().settings) =>
  settings.engine === 'webllm' ? `${usesCpu(settings) ? 'cpu' : 'gpu'}:${shortModel(model)}` : `${settings.engine}:${model}`;
export function recordSpeed(model, tps, settings = useStore.getState().settings) {
  if (!(tps > 0) || !isFinite(tps)) return;
  const key = speedKey(model, settings);
  const speeds = settings.modelSpeeds || {};
  const prev = speeds[key];
  useStore.getState().setSettings({ modelSpeeds: { ...speeds, [key]: prev ? prev * 0.6 + tps * 0.4 : tps } });
}

/** Tiny models (any engine) get the short "lite" prompt and a small context so they stay fast. */
/** In-browser models up to 3B: light enough for the short prompt and a 4k context. */
export const isSmallBrowserModel = (id = '') => /(^|[-_])(0\.5|0\.6|1|1\.5|3)B([-_]|$)/i.test(id);
export const isPocketModel = (id = '') => WEBLLM_MODELS.some((m) => m.pocket && m.id === id) || /(^|[:\-_])(0\.5b|360m|135m|0\.6b|1b|1\.1b)\b/i.test(id);
export const isMobile = () => typeof navigator !== 'undefined' && (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)));
/** Ask the model to think out loud? Auto: yes for normal models without their own thinking mode, no for tiny ones. */
export function thinkAloud(settings = useStore.getState().settings) {
  const model = currentModel(settings);
  if (thinksNatively(model) || settings.thinkAloud === 'off') return false;
  return settings.thinkAloud === 'on' || !liteMode(settings);
}

export function liteMode(settings = useStore.getState().settings) {
  if (settings.lite === 'on') return true;
  if (settings.lite === 'off') return false;
  // CPU mode reads prompts slowly, so it always gets the short prompt. So do in-browser models up to 3B: reading the
  // full prompt (~2.5k tokens) before every reply maxes out a laptop GPU for many seconds and the whole screen stutters.
  return isPocketModel(currentModel(settings)) || (settings.engine === 'webllm' && (usesCpu(settings) || isSmallBrowserModel(currentModel(settings))));
}

let webllmEngine = null;
let webllmLoaded = ''; // the build in GPU memory
let webllmReady = ''; // …and it passed the GPU check (only then may chats use it)
let webllmLoading = null;

// WebLLM runs ONE generation at a time. Two at once (e.g. the GPU check while a chat starts) corrupt its
// conversation state ("Message error should not be 0"), so every use of the engine waits its turn.
let engineTail = Promise.resolve();
function acquireEngine() {
  let release;
  const mine = new Promise((r) => (release = r));
  const before = engineTail;
  engineTail = before.then(() => mine);
  return before.then(() => release);
}

export const hasWebGPU = () => typeof navigator !== 'undefined' && 'gpu' in navigator;

// Every in-browser model comes in two builds: q4f16 (half-precision GPU math, faster) and q4f32 (full precision).
// Some GPUs — often Chromebooks — say they support f16 but compute it wrong, which turns replies into word salad.
let f16Support = null;
async function gpuSupportsF16() {
  if (f16Support !== null) return f16Support;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    f16Support = !!adapter?.features?.has('shader-f16');
  } catch {
    f16Support = false;
  }
  return f16Support;
}
export const isChromebook = () => typeof navigator !== 'undefined' && /\bCrOS\b/.test(navigator.userAgent);

/** 'f16' or 'f32' for in-browser models on this device. */
export async function webllmPrecision(settings = useStore.getState().settings) {
  if (settings.webllmPrecision === 'f16' || settings.webllmPrecision === 'f32') return settings.webllmPrecision;
  if (isChromebook()) return 'f32';
  return (await gpuSupportsF16()) ? 'f16' : 'f32';
}
/** "f32" / "f16" for a WebLLM model id, or '' for other engines. */
export const precisionOf = (id = '') => (/^cpu:/.test(id) ? 'cpu' : /q4f32_1/.test(id) ? 'f32' : /q4f16_1/.test(id) ? 'f16' : '');
export const shortModel = (id = '') => id.replace(/^cpu:/, '').replace(/-q4f(16|32)_1-MLC$/, '');

// On the CPU every token counts: point people at the smallest coder model once per visit (never switch it for them).
let cpuTipShown = false;
function cpuTip(model) {
  const coder = WEBLLM_MODELS.find((m) => m.pocket);
  if (cpuTipShown || shortModel(model) === shortModel(coder.id)) return;
  cpuTipShown = true;
  useStore.getState().toast(`Tip: on CPU, ${coder.label} is the fastest model for code — pick it in the model menu`, 'info');
}
const withPrecision = (model, precision) => (precision === 'f32' ? model.replace('q4f16_1', 'q4f32_1') : model);

/** Run in-browser models on the CPU (wllama) instead of WebGPU? */
export function usesCpu(settings = useStore.getState().settings) {
  if (settings.webllmDevice === 'cpu') return true;
  if (settings.webllmDevice === 'gpu') return false;
  return !hasWebGPU() || !!settings.gpuBroken;
}

// Models that already passed the GPU check on this device (so the check runs once per model build).
const VERIFIED_KEY = 'buddo-gpu-verified-2'; // -2: the check now includes a long prompt
const verified = () => {
  try {
    return JSON.parse(localStorage.getItem(VERIFIED_KEY) || '[]');
  } catch {
    return [];
  }
};
const markVerified = (id) => {
  try {
    localStorage.setItem(VERIFIED_KEY, JSON.stringify([...new Set([...verified(), id])]));
  } catch {}
};

const CJK = /[぀-ヿ㐀-鿿가-힯]/;
/** A reply a working model could give: real words, no glitch characters. */
const looksSane = (t = '', prompt = '') => {
  const s = t.trim();
  return /[a-z]{3,}|\b4\b/i.test(s) && !looksGarbled(s.padEnd(60, ' '), prompt) && !(CJK.test(s) && !CJK.test(prompt));
};
// About 1,500 tokens: broken GPU math often only shows up once the prompt gets long (like a real chat).
const LONG_CONTEXT = `You are checking a web page. The secret word is BANANA.\n\n${Array.from({ length: 14 }, (_, i) =>
  `<section id="part-${i}">\n  <h2>Part ${i}</h2>\n  <p>This section explains step ${i} of building a small website with HTML, CSS and JavaScript.</p>\n  <button class="btn" onclick="count(${i})">Click ${i}</button>\n</section>`,
).join('\n')}`;

/** Ask the loaded model easy questions, with a short and a long prompt. Broken GPU math can't answer them. */
async function gpuGivesSaneAnswers(engine) {
  const ask = async (messages, max = 48) => {
    const release = await acquireEngine();
    try {
      const r = await engine.chat.completions.create({ messages, temperature: 0, max_tokens: max });
      await engine.resetChat?.()?.catch?.(() => {});
      return r.choices?.[0]?.message?.content || '';
    } finally {
      release();
    }
  };
  const short = await ask([{ role: 'user', content: 'What is 2+2? Reply with just the number.' }]);
  if (!/\b4\b|\bfour\b/i.test(short) && !looksSane(await ask([{ role: 'user', content: 'Say hello.' }]), 'Say hello.')) return false;
  useStore.setState({ webllm: { text: 'Checking your GPU with a longer message…', progress: 0 } });
  const q = 'What is the secret word mentioned at the top? Answer in one short sentence.';
  const long = await ask([{ role: 'system', content: LONG_CONTEXT }, { role: 'user', content: q }], 40);
  return /banana/i.test(long) || looksSane(long, q);
}

/** After gibberish from a model that passed before: check the GPU again. Returns false if it's broken. */
export async function recheckGpu() {
  if (!webllmEngine || !webllmLoaded) return true;
  try {
    localStorage.setItem(VERIFIED_KEY, JSON.stringify(verified().filter((x) => x !== webllmLoaded)));
  } catch {}
  useStore.setState({ webllm: { text: 'Checking your GPU again…', progress: 0 } });
  const ok = await gpuGivesSaneAnswers(webllmEngine).catch(() => false);
  if (ok) markVerified(webllmLoaded);
  useStore.setState({ webllm: { text: 'Ready', progress: 1, ready: true, loaded: webllmLoaded } });
  return ok;
}

let webllmLib = null;
/** The model runs in a Web Worker: on the page's own thread every token froze the whole UI. */
async function createEngine(model, config, ctx) {
  let worker = null;
  try {
    worker = new Worker(new URL('./webllm-worker.js', import.meta.url), { type: 'module' });
    return await webllmLib.CreateWebWorkerMLCEngine(worker, model, config, ctx);
  } catch (e) {
    worker?.terminate();
    if (!worker) return webllmLib.CreateMLCEngine(model, config, ctx); // no module workers here (very old browser)
    throw e;
  }
}
async function loadOnGpu(model) {
  const status = (text, progress = 0) => useStore.setState({ webllm: { text, progress } });
  status('Loading WebLLM runtime…');
  // Bundled with the site: a CDN (esm.run) is often blocked on school/work networks and by ad blockers.
  webllmLib ||= await import('@mlc-ai/web-llm').catch(() => import(/* @vite-ignore */ 'https://esm.run/@mlc-ai/web-llm@0.2'));
  const onProgress = (p) => status(p.text, p.progress);
  // A smaller window means less GPU memory and less work per token on laptop GPUs.
  const ctx = { context_window_size: isPocketModel(model) || isSmallBrowserModel(model) ? 4096 : 8192 };
  webllmReady = '';
  const release = await acquireEngine();
  try {
    if (webllmEngine) {
      webllmEngine.setInitProgressCallback?.(onProgress);
      await webllmEngine.reload(model, ctx);
    } else {
      webllmEngine = await createEngine(model, { initProgressCallback: onProgress }, ctx);
    }
  } finally {
    release();
  }
  webllmLoaded = model;
  return webllmEngine;
}

/**
 * Load an in-browser model and make sure this GPU computes it correctly. If it doesn't:
 * fast f16 → safe f32 → fresh download (the saved copy may be damaged) → give up on the GPU (CPU mode).
 */
export async function loadWebLLM(baseModel) {
  if (usesCpu()) return loadCpu(baseModel);
  let precision = await webllmPrecision();
  let model = withPrecision(baseModel, precision);
  if (webllmEngine && webllmReady === model) return webllmEngine;
  // Already loading/checking (e.g. started when the model was picked): wait for that to finish.
  if (webllmLoading) return webllmLoading;
  const st = useStore.getState();
  const checking = (text) => useStore.setState({ webllm: { text, progress: 0 } });
  webllmLoading = (async () => {
    let engine = await loadOnGpu(model);
    if (verified().includes(model)) return engine;
    checking('Checking that your GPU gives correct answers…');
    if (await gpuGivesSaneAnswers(engine)) return engine;

    if (precision === 'f16') {
      st.setSettings({ webllmPrecision: 'f32' });
      st.toast('Your GPU got the fast (f16) math wrong — switching to the safe (f32) version', 'info');
      precision = 'f32';
      model = withPrecision(baseModel, 'f32');
      engine = await loadOnGpu(model);
      checking('Checking the safe (f32) version…');
      if (await gpuGivesSaneAnswers(engine)) return engine;
    }

    checking('Wrong answers — downloading a fresh copy (the saved one may be damaged)…');
    await webllmLib.deleteModelAllInfoInCache?.(model).catch?.(() => {});
    webllmLoaded = '';
    engine = await loadOnGpu(model);
    checking('Checking the fresh copy…');
    if (await gpuGivesSaneAnswers(engine)) return engine;

    st.setSettings({ gpuBroken: true });
    await webllmEngine?.unload?.().catch?.(() => {}); // free the GPU memory; the CPU takes over
    webllmEngine = null;
    webllmLoaded = '';
    const err = new Error('GPU_BROKEN: this GPU computes the model wrong even in safe mode. Buddo will use the CPU instead.');
    err.gpuBroken = true;
    throw err;
  })();
  webllmLoading = webllmLoading.then((engine) => {
    webllmReady = webllmLoaded;
    markVerified(webllmLoaded);
    useStore.setState({ webllm: { text: 'Ready', progress: 1, ready: true, loaded: webllmLoaded } });
    return engine;
  });
  try {
    return await webllmLoading;
  } catch (e) {
    useStore.setState({ webllm: { text: e.message, progress: 0, error: !e.gpuBroken } });
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
      return {};
    },
    async listModels() {
      return WEBLLM_MODELS.map((m) => ({ id: m.id, label: m.label }));
    },
    async *stream({ model, messages, signal, options = {} }) {
      const cpu = () => {
        cpuTip(model);
        return cpuStream({ model, messages, signal, temperature: options.temperature ?? 0.2 });
      };
      if (usesCpu()) return yield* cpu();
      let engine;
      try {
        engine = await loadWebLLM(model);
      } catch (e) {
        if (!e.gpuBroken) throw e;
        useStore.getState().toast("Your GPU can't run this model correctly — switched to CPU mode (slower, but it works)", 'info');
        return yield* cpu();
      }
      const prompt = [...messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith('<tool_result'))?.content || '';
      let text = '';
      const release = await acquireEngine();
      let it = null;
      let finished = false;
      try {
        // WebLLM keeps the conversation in its KV cache between calls; start clean when asked (e.g. after an empty reply).
        if (options.fresh) await engine.resetChat?.();
        const chunks = await engine.chat.completions.create({
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          temperature: options.temperature ?? 0.2,
          // Room for a complete small web page (index.html + css + js) even on Pocket models.
          max_tokens: 2048,
          stream_options: { include_usage: true },
        });
        // Iterate by hand: leaving a `for await` early would abandon WebLLM mid-reply (see finally).
        it = chunks[Symbol.asyncIterator]();
        while (true) {
          const { value: c, done } = await it.next();
          if (done) {
            finished = true;
            break;
          }
          if (signal?.aborted) break;
          const t = c.choices?.[0]?.delta?.content;
          if (t) {
            // Catch broken GPU math early instead of streaming a wall of nonsense.
            if (text.length < 1500 && looksGarbled((text += t), prompt)) {
              throw new Error(`GARBLED: the model's output came out as gibberish — this GPU computes the ${precisionOf(webllmLoaded) || 'fast'} version wrong.`);
            }
            yield { type: 'text', text: t };
          }
          if (c.choices?.[0]?.finish_reason) yield { type: 'finish', reason: c.choices[0].finish_reason };
          if (c.usage) yield { type: 'usage', prompt: c.usage.prompt_tokens, completion: c.usage.completion_tokens, tps: c.usage.extra?.decode_tokens_per_s };
        }
      } finally {
        // Stopped early (tool call found, gibberish, user pressed stop): tell WebLLM to stop and let it finish
        // its bookkeeping, so the next message starts from a clean state.
        if (it && !finished) {
          engine.interruptGenerate();
          try {
            while (!(await it.next()).done);
          } catch {}
        }
        release();
      }
      // A whole reply of one or two symbols ("?", "(") is what broken GPU math looks like.
      const t = text.trim();
      if (t && t.length <= 4 && !/[\p{L}\p{N}]{2,}/u.test(t) && !signal?.aborted) {
        throw new Error(`GARBLED: the model only wrote "${t}" — that usually means the GPU computed it wrong.`);
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

// Only offer screenshot / record_video / make_video when the server has a browser to drive.
let browserOk = null;
function withServerExtras(ws) {
  if (browserOk === false) {
    delete ws.media.screenshot;
    delete ws.media.record_video;
    delete ws.media.make_video;
  }
  return ws;
}
async function makeServerWorkspace(info) {
  const ws = serverWorkspace(info);
  ws.info = info;
  browserOk = await (browserOk ?? api('/api/browser/status').then((b) => b.available).catch(() => false));
  return withServerExtras(ws);
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
