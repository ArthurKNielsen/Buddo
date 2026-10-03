// CPU engine for in-browser models: llama.cpp compiled to WebAssembly (wllama).
// Slower than WebGPU, but it works on every computer — including GPUs whose WebGPU math is broken
// (some Chromebooks) and browsers without WebGPU at all.

import wasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';
import { useStore } from './store.js';

// WebLLM model id → the same model as GGUF on Hugging Face (wllama picks the Q4_K_M file, else Q8_0).
const GGUF = {
  'Qwen2.5-Coder-0.5B-Instruct': 'Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF',
  'Qwen2.5-Coder-1.5B-Instruct': 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF',
  'Qwen2.5-Coder-3B-Instruct': 'Qwen/Qwen2.5-Coder-3B-Instruct-GGUF',
  'SmolLM2-360M-Instruct': 'HuggingFaceTB/SmolLM2-360M-Instruct-GGUF',
  'Qwen3-0.6B': 'Qwen/Qwen3-0.6B-GGUF',
  'Llama-3.2-1B-Instruct': 'bartowski/Llama-3.2-1B-Instruct-GGUF',
  'Llama-3.2-3B-Instruct': 'bartowski/Llama-3.2-3B-Instruct-GGUF',
};
const baseId = (id = '') => id.replace(/-q4f(16|32)_1-MLC$/, '');

/** Hugging Face repo for running this model on the CPU, or null if it's too big for CPU mode. */
export const cpuRepo = (id) => GGUF[baseId(id)] || null;
export const cpuSupports = (id) => !!cpuRepo(id);

let wllama = null;
let loaded = '';
let loading = null;

export async function loadCpu(model) {
  const repo = cpuRepo(model);
  if (!repo) throw new Error(`${baseId(model)} is too big for CPU mode. Pick a model up to 3B (Pocket models are fastest).`);
  if (wllama && loaded === repo) return wllama;
  if (loading) return loading;
  loading = (async () => {
    useStore.setState({ webllm: { text: 'Loading CPU engine…', progress: 0, cpu: true } });
    const { Wllama } = await import('@wllama/wllama');
    if (wllama) await wllama.exit().catch(() => {});
    wllama = new Wllama({ default: wasmUrl }, { suppressNativeLog: true });
    await wllama.loadModelFromHF(
      { repo },
      {
        n_ctx: 4096,
        n_gpu_layers: 0, // CPU only: the whole point is to avoid a broken GPU
        progressCallback: ({ loaded: done, total }) =>
          useStore.setState({ webllm: { text: `Downloading ${baseId(model)} for CPU… ${Math.round((done / total) * 100)}%`, progress: total ? done / total : 0, cpu: true } }),
      },
    );
    loaded = repo;
    // One thread means the page isn't cross-origin isolated (see public/coi-sw.js) — say so, it's ~2–4× slower.
    const threads = wllama.getNumThreads?.() || 1;
    useStore.setState({ webllm: { text: `Ready (CPU, ${threads} thread${threads === 1 ? '' : 's'})`, progress: 1, ready: true, loaded: `cpu:${baseId(model)}`, cpu: true, threads } });
    return wllama;
  })();
  try {
    return await loading;
  } catch (e) {
    wllama = null;
    loaded = '';
    useStore.setState({ webllm: { text: e.message, progress: 0, error: true, cpu: true } });
    throw e;
  } finally {
    loading = null;
  }
}

/** Stream a chat reply on the CPU. Yields the same chunks as the other providers. */
export async function* cpuStream({ model, messages, signal, temperature = 0.2, maxTokens = 2048 }) {
  const engine = await loadCpu(model);
  let first = 0;
  let count = 0;
  const stream = await engine.createChatCompletion({
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    temperature,
    max_tokens: maxTokens,
    abortSignal: signal,
  });
  let usage = false;
  try {
    for await (const c of stream) {
      const t = c.choices?.[0]?.delta?.content;
      if (t) {
        first ||= performance.now();
        count++;
        yield { type: 'text', text: t };
      }
      if (c.choices?.[0]?.finish_reason) yield { type: 'finish', reason: c.choices[0].finish_reason };
      if (c.usage) usage = true;
      if (c.usage) yield { type: 'usage', prompt: c.usage.prompt_tokens, completion: c.usage.completion_tokens, tps: first ? count / ((performance.now() - first) / 1000) : 0 };
    }
  } catch (e) {
    if (signal?.aborted) return;
    throw e;
  }
  // wllama doesn't always report usage: time the reply ourselves (one streamed piece ≈ one token).
  const secs = first ? (performance.now() - first) / 1000 : 0;
  if (!usage && count > 1 && secs > 0) yield { type: 'usage', completion: count, tps: count / secs };
}
