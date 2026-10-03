// Free, local model providers. No API keys, ever.
//  - ollama: https://ollama.com (default http://localhost:11434)
//  - openai-compatible local servers: LM Studio, llama.cpp server, Jan, LocalAI, vLLM…

async function* readLines(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

async function check(res) {
  if (res.ok) return res;
  let msg = `${res.status} ${res.statusText}`;
  try {
    const t = await res.text();
    try {
      msg = JSON.parse(t).error?.message || JSON.parse(t).error || t || msg;
    } catch {
      msg = t || msg;
    }
  } catch {}
  throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

/** Tiny models (≤1B) get Buddo's short "lite" prompt and a small context so they stay fast. */
export function isTinyModel(id = '') {
  return /(^|[:\-_/])(0\.5b|360m|135m|0\.6b|1b|1\.1b)\b/i.test(id) || /^(Qwen2\.5-Coder-0\.5B|SmolLM2-360M|Qwen3-0\.6B|Llama-3\.2-1B)/i.test(id);
}

/** Best guess from the model name when the server can't tell us. */
export function guessVision(model = '') {
  return /vl\b|vl:|vision|llava|bakllava|gemma3(?!n)|minicpm-v|pixtral|moondream|qwen2\.5vl|qwen3-vl|granite3\.2-vision|mistral-small3\.[12]|llama4|smolvlm/i.test(model);
}

const toOpenAI = (messages) =>
  messages.map((m) =>
    m.images?.length
      ? { role: m.role, content: [{ type: 'text', text: m.content }, ...m.images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b}` } }))] }
      : { role: m.role, content: m.content },
  );

export function ollamaProvider({ baseUrl = 'http://localhost:11434', headers = {}, fetch: f = globalThis.fetch.bind(globalThis) } = {}) {
  const url = (p) => baseUrl.replace(/\/$/, '') + p;
  return {
    id: 'ollama',
    label: 'Ollama',
    async ping() {
      const r = await f(url('/api/version'), { headers });
      await check(r);
      return r.json();
    },
    async listModels() {
      const r = await check(await f(url('/api/tags'), { headers }));
      const j = await r.json();
      return (j.models || []).map((m) => ({
        id: m.name,
        size: m.size,
        params: m.details?.parameter_size,
        family: m.details?.family,
        quant: m.details?.quantization_level,
      }));
    },
    async modelInfo(model) {
      try {
        const r = await check(await f(url('/api/show'), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model }) }));
        const j = await r.json();
        const caps = j.capabilities || [];
        return { vision: caps.length ? caps.includes('vision') : guessVision(model) || !!j.projector_info, capabilities: caps };
      } catch {
        return { vision: guessVision(model) };
      }
    },
    async *stream({ model, messages, signal, options = {} }) {
      const r = await check(
        await f(url('/api/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            keep_alive: '30m',
            options: { num_ctx: options.num_ctx || 16384, temperature: options.temperature ?? 0.2 },
          }),
          signal,
        }),
      );
      for await (const line of readLines(r.body)) {
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        if (j.error) throw new Error(j.error);
        if (j.message?.thinking) yield { type: 'thinking', text: j.message.thinking };
        if (j.message?.content) yield { type: 'text', text: j.message.content };
        if (j.done) {
          if (j.done_reason) yield { type: 'finish', reason: j.done_reason };
          yield {
            type: 'usage',
            prompt: j.prompt_eval_count || 0,
            completion: j.eval_count || 0,
            tps: j.eval_duration ? (j.eval_count / j.eval_duration) * 1e9 : 0,
          };
        }
      }
    },
    /** Download a model; yields {status, completed, total}. */
    async *pull(model, { signal } = {}) {
      const r = await check(
        await f(url('/api/pull'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ model, stream: true }),
          signal,
        }),
      );
      for await (const line of readLines(r.body)) {
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        yield j;
      }
    },
    async deleteModel(model) {
      await check(await f(url('/api/delete'), { method: 'DELETE', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model }) }));
    },
  };
}

export function openaiCompatProvider({ baseUrl = 'http://localhost:1234/v1', headers = {}, fetch: f = globalThis.fetch.bind(globalThis) } = {}) {
  const url = (p) => baseUrl.replace(/\/$/, '') + p;
  return {
    id: 'openai',
    label: 'LM Studio / OpenAI-compatible',
    async ping() {
      await check(await f(url('/models'), { headers }));
      return {};
    },
    async listModels() {
      const r = await check(await f(url('/models'), { headers }));
      const j = await r.json();
      return (j.data || []).map((m) => ({ id: m.id }));
    },
    async modelInfo(model) {
      return { vision: guessVision(model) };
    },
    async *stream({ model, messages, signal, options = {} }) {
      const r = await check(
        await f(url('/chat/completions'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ model, messages: toOpenAI(messages), stream: true, temperature: options.temperature ?? 0.2, stream_options: { include_usage: true } }),
          signal,
        }),
      );
      for await (const line of readLines(r.body)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        const d = j.choices?.[0]?.delta || {};
        const think = d.reasoning_content || d.reasoning;
        if (think) yield { type: 'thinking', text: think };
        if (d.content) yield { type: 'text', text: d.content };
        if (j.choices?.[0]?.finish_reason) yield { type: 'finish', reason: j.choices[0].finish_reason };
        if (j.usage) yield { type: 'usage', prompt: j.usage.prompt_tokens || 0, completion: j.usage.completion_tokens || 0 };
      }
    },
  };
}

/** Models we recommend, roughly ordered by quality-per-GB for coding agents. */
export const RECOMMENDED_MODELS = [
  { id: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B', size: '4.7 GB', note: 'Best all-rounder for most laptops', tag: 'Recommended' },
  { id: 'qwen3:8b', label: 'Qwen 3 8B', size: '5.2 GB', note: 'Strong reasoning with thinking mode', tag: 'Smart' },
  { id: 'qwen2.5-coder:14b', label: 'Qwen 2.5 Coder 14B', size: '9.0 GB', note: 'Noticeably smarter, needs 16 GB+ RAM', tag: 'Pro' },
  { id: 'qwen3-coder:30b', label: 'Qwen 3 Coder 30B', size: '19 GB', note: 'Top-tier local agent, needs 32 GB+ RAM', tag: 'Beast' },
  { id: 'gpt-oss:20b', label: 'gpt-oss 20B', size: '14 GB', note: 'Open-weight reasoning model', tag: 'Reasoning' },
  { id: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B', size: '8.9 GB', note: 'Fast MoE coder', tag: 'Fast' },
  { id: 'qwen2.5vl:7b', label: 'Qwen 2.5 VL 7B', size: '6.0 GB', note: 'Sees images & video frames 👁', tag: 'Vision' },
  { id: 'gemma3:4b', label: 'Gemma 3 4B', size: '3.3 GB', note: 'Small, fast, sees images 👁', tag: 'Vision' },
  { id: 'qwen2.5-coder:1.5b', label: 'Qwen 2.5 Coder 1.5B', size: '1.0 GB', note: 'Pocket-size, very fast ⚡', tag: 'Fast' },
  { id: 'qwen2.5-coder:3b', label: 'Qwen 2.5 Coder 3B', size: '1.9 GB', note: 'For low-RAM machines', tag: 'Light' },
];

/** Models that already reason in their own thinking channel (no need to ask them to think out loud). */
export const thinksNatively = (id = '') => /qwen3(?![-.]?coder)|deepseek-r1|\br1\b|gpt-oss|qwq|magistral|reason|think|exaone-deep|cogito/i.test(id);
