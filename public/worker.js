// Buddo's brain: runs the from-scratch transformer right in the browser.
// No libraries. Loads buddo-model.bin + tokenizer.json, then generates text
// token by token with a key/value cache so long chats stay fast.

const USER = 256, BOT = 257, END = 258, FIRST_MERGE_ID = 259;

// ---------- tokenizer (mirror of model/tokenizer.py) ----------

let ranks = null; // "a,b" -> rank
let vocabBytes = null; // id -> Uint8Array

function isWord(c) {
  return /^[A-Za-z0-9_]$/.test(c);
}

function pretokenize(text) {
  const t = Array.from(text); // code points, like Python strings
  const chunks = [];
  const n = t.length;
  let i = 0;
  while (i < n) {
    const c = t[i];
    if (c === "\n") {
      chunks.push("\n");
      i++;
    } else if (c === " ") {
      let j = i;
      while (j < n && t[j] === " ") j++;
      if (j < n && t[j] !== "\n") {
        if (j - 1 > i) chunks.push(t.slice(i, j - 1).join(""));
        i = j - 1;
        const start = i;
        i++;
        if (isWord(t[i])) {
          while (i < n && isWord(t[i])) i++;
        } else {
          i++;
        }
        chunks.push(t.slice(start, i).join(""));
      } else {
        chunks.push(t.slice(i, j).join(""));
        i = j;
      }
    } else if (isWord(c)) {
      let j = i;
      while (j < n && isWord(t[j])) j++;
      chunks.push(t.slice(i, j).join(""));
      i = j;
    } else {
      chunks.push(c);
      i++;
    }
  }
  return chunks;
}

const encoder = new TextEncoder();
const chunkCache = new Map();

function encodeChunk(chunk) {
  const hit = chunkCache.get(chunk);
  if (hit) return hit;
  let ids = Array.from(encoder.encode(chunk));
  while (ids.length > 1) {
    let best = -1, bestRank = Infinity;
    for (let k = 0; k < ids.length - 1; k++) {
      const r = ranks.get(ids[k] * 65536 + ids[k + 1]);
      if (r !== undefined && r < bestRank) {
        best = k;
        bestRank = r;
      }
    }
    if (best < 0) break;
    ids.splice(best, 2, FIRST_MERGE_ID + bestRank);
  }
  if (chunkCache.size < 50000) chunkCache.set(chunk, ids);
  return ids;
}

function encode(text) {
  const out = [];
  for (const c of pretokenize(text)) for (const id of encodeChunk(c)) out.push(id);
  return out;
}

function loadTokenizer(json) {
  ranks = new Map();
  vocabBytes = [];
  for (let i = 0; i < 256; i++) vocabBytes[i] = new Uint8Array([i]);
  json.specials.forEach((s, i) => (vocabBytes[256 + i] = encoder.encode(s)));
  json.merges.forEach(([a, b], k) => {
    ranks.set(a * 65536 + b, k);
    const ab = new Uint8Array(vocabBytes[a].length + vocabBytes[b].length);
    ab.set(vocabBytes[a]);
    ab.set(vocabBytes[b], vocabBytes[a].length);
    vocabBytes[FIRST_MERGE_ID + k] = ab;
  });
}

// ---------- model ----------

let cfg = null;
let W = null; // name -> Float32Array

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function loadModel(buf) {
  const view = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== "BUDO") throw new Error("Not a Buddo model file");
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen)));
  cfg = header.config;
  const table = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) table[i] = halfToFloat(i);
  const base = 8 + headerLen;
  W = {};
  for (const t of header.tensors) {
    const n = t.shape.reduce((a, b) => a * b, 1);
    const half = new Uint16Array(buf, base + t.offset, n);
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = table[half[i]];
    W[t.name] = f;
  }
}

// y = W x + b, with W stored [out, in]
function linear(x, w, b, out, inDim) {
  const y = new Float32Array(out);
  for (let o = 0; o < out; o++) {
    let s = b ? b[o] : 0;
    const row = o * inDim;
    for (let i = 0; i < inDim; i++) s += w[row + i] * x[i];
    y[o] = s;
  }
  return y;
}

function layerNorm(x, g, b) {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (x[i] - mean) ** 2;
  const inv = 1 / Math.sqrt(v / n + 1e-5);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = (x[i] - mean) * inv * g[i] + b[i];
  return y;
}

function gelu(x) {
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    x[i] = 0.5 * v * (1 + Math.tanh(0.7978845608028654 * (v + 0.044715 * v * v * v)));
  }
  return x;
}

// Key/value cache, grown in chunks so short chats use little memory.
let cacheTokens = [];
let kCache = [], vCache = [], cacheCap = 0;

function resetCache() {
  cacheTokens = [];
  kCache = [];
  vCache = [];
  cacheCap = 0;
}

function ensureCap(n) {
  if (n <= cacheCap) return;
  const d = cfg.d_model;
  const cap = Math.max(n, cacheCap * 2, 256);
  for (let l = 0; l < cfg.n_layer; l++) {
    const k = new Float32Array(cap * d), v = new Float32Array(cap * d);
    if (kCache[l]) {
      k.set(kCache[l]);
      v.set(vCache[l]);
    }
    kCache[l] = k;
    vCache[l] = v;
  }
  cacheCap = cap;
}

let slopes = null;

// Feed one token at position cacheTokens.length; returns logits if wanted.
function step(token, wantLogits) {
  const d = cfg.d_model, H = cfg.n_head, hd = d / H;
  const pos = cacheTokens.length;
  ensureCap(pos + 1);
  if (!slopes) slopes = Array.from({ length: H }, (_, h) => Math.pow(2, (-8 * (h + 1)) / H));

  let x = W["embed.weight"].slice(token * d, token * d + d);
  const scale = 1 / Math.sqrt(hd);
  const scores = new Float32Array(pos + 1);

  for (let l = 0; l < cfg.n_layer; l++) {
    const p = `blocks.${l}.`;
    const h = layerNorm(x, W[p + "ln1.weight"], W[p + "ln1.bias"]);
    const qkv = linear(h, W[p + "qkv.weight"], W[p + "qkv.bias"], 3 * d, d);
    const K = kCache[l], V = vCache[l];
    K.set(qkv.subarray(d, 2 * d), pos * d);
    V.set(qkv.subarray(2 * d, 3 * d), pos * d);
    const att = new Float32Array(d);
    for (let hh = 0; hh < H; hh++) {
      const off = hh * hd;
      let max = -Infinity;
      for (let t = 0; t <= pos; t++) {
        let s = 0;
        const kb = t * d + off;
        for (let i = 0; i < hd; i++) s += qkv[off + i] * K[kb + i];
        s = s * scale + slopes[hh] * (t - pos);
        scores[t] = s;
        if (s > max) max = s;
      }
      let sum = 0;
      for (let t = 0; t <= pos; t++) {
        const e = Math.exp(scores[t] - max);
        scores[t] = e;
        sum += e;
      }
      for (let t = 0; t <= pos; t++) {
        const w = scores[t] / sum;
        if (w < 1e-7) continue;
        const vb = t * d + off;
        for (let i = 0; i < hd; i++) att[off + i] += w * V[vb + i];
      }
    }
    const a = linear(att, W[p + "proj.weight"], W[p + "proj.bias"], d, d);
    for (let i = 0; i < d; i++) x[i] += a[i];
    const h2 = layerNorm(x, W[p + "ln2.weight"], W[p + "ln2.bias"]);
    const f = gelu(linear(h2, W[p + "fc.weight"], W[p + "fc.bias"], 4 * d, d));
    const o = linear(f, W[p + "out.weight"], W[p + "out.bias"], d, 4 * d);
    for (let i = 0; i < d; i++) x[i] += o[i];
  }
  cacheTokens.push(token);
  if (!wantLogits) return null;
  const xf = layerNorm(x, W["ln_f.weight"], W["ln_f.bias"]);
  return linear(xf, W["embed.weight"], null, cfg.vocab_size, d);
}

function sample(logits, temperature, topK, recent) {
  for (const t of recent) logits[t] -= 1.0; // gentle repetition penalty
  const idx = Array.from(logits.keys()).sort((a, b) => logits[b] - logits[a]).slice(0, topK);
  const max = logits[idx[0]];
  const probs = idx.map((i) => Math.exp((logits[i] - max) / temperature));
  const total = probs.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let k = 0; k < idx.length; k++) {
    r -= probs[k];
    if (r <= 0) return idx[k];
  }
  return idx[idx.length - 1];
}

// ---------- chat ----------

let stopRequested = false;
const tick = () => new Promise((r) => setTimeout(r, 0));

function buildPrompt(turns) {
  const ids = [];
  for (const t of turns) {
    if (t.role === "user") ids.push(USER, ...encode(t.content), BOT);
    else ids.push(...encode(t.content), END);
  }
  return ids;
}

async function generate({ turns, contextLimit, maxNew, temperature }) {
  stopRequested = false;
  // Drop the oldest exchanges until prompt + reply fit in the context window.
  let dropped = 0;
  let ids = buildPrompt(turns);
  while (ids.length + maxNew > contextLimit && turns.length > 1) {
    turns = turns.slice(2);
    dropped += 2;
    ids = buildPrompt(turns);
  }
  if (ids.length + maxNew > contextLimit) {
    // A single message bigger than the window: keep its end.
    ids = [USER, ...ids.slice(ids.length - (contextLimit - maxNew - 1))];
  }

  // Reuse the cache when the old tokens are a prefix of the new prompt.
  let same = 0;
  while (same < cacheTokens.length && same < ids.length && cacheTokens[same] === ids[same]) same++;
  // Attention is causal, so cached keys/values before the first difference stay valid.
  if (same === ids.length) same--; // need fresh logits for the last prompt token
  cacheTokens.length = same;
  postMessage({ type: "context", used: ids.length, dropped, limit: contextLimit });

  const todo = ids.slice(same);
  let logits = null;
  for (let k = 0; k < todo.length; k++) {
    logits = step(todo[k], k === todo.length - 1);
    if (k % 64 === 63) {
      postMessage({ type: "progress", done: k + 1, total: todo.length });
      await tick();
      if (stopRequested) return postMessage({ type: "done", text: "", stopped: true });
    }
  }

  const decoder = new TextDecoder();
  let text = "";
  const recent = [];
  for (let n = 0; n < maxNew; n++) {
    const tok = sample(logits, temperature, 40, recent);
    if (tok === END || tok === USER || tok === BOT) {
      step(END, false); // keep the cache in sync with the transcript
      return postMessage({ type: "done", text, stopped: false });
    }
    recent.push(tok);
    if (recent.length > 24) recent.shift();
    text += decoder.decode(vocabBytes[tok], { stream: true });
    postMessage({ type: "text", text });
    logits = step(tok, true);
    if (n % 4 === 3) {
      await tick();
      if (stopRequested) break;
    }
  }
  text += decoder.decode();
  step(END, false);
  postMessage({ type: "done", text, stopped: stopRequested, truncated: !stopRequested });
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      const [tokRes, modelRes] = await Promise.all([fetch(msg.tokenizerUrl), fetch(msg.modelUrl)]);
      if (!tokRes.ok || !modelRes.ok) throw new Error("Couldn't download the model files");
      loadTokenizer(await tokRes.json());
      loadModel(await modelRes.arrayBuffer());
      postMessage({ type: "ready", config: cfg });
    } else if (msg.type === "generate") {
      await generate(msg);
    } else if (msg.type === "stop") {
      stopRequested = true;
    } else if (msg.type === "reset") {
      resetCache();
    }
  } catch (err) {
    postMessage({ type: "error", message: err.message });
  }
};
