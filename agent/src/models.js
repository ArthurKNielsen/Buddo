// The coding models Buddo can run, all Qwen2.5-Coder (Apache-2.0), compiled for
// WebGPU by the MLC project. "Preinstalled" models are copied into this site by
// the deploy workflow, so they come from the same address as the app. The rest
// download once from the MLC model host. Either way, the browser keeps them.

export const MODELS = [
  { key: "0.5B", label: "Coder 0.5B", note: "Tiny: older phones", gb: 0.4, ctx: 4096, maxReply: 1536, vramMB: 945, lib: { f16: "Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm", f32: "Qwen2-0.5B-Instruct-q4f32_1_cs1k-webgpu.wasm" } },
  { key: "1.5B", label: "Coder 1.5B", note: "Phones", gb: 1.0, ctx: 8192, maxReply: 2048, vramMB: 1630, lib: { f16: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm", f32: "Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm" } },
  { key: "3B", label: "Coder 3B", note: "Laptops & strong phones", gb: 1.8, ctx: 8192, maxReply: 3072, vramMB: 2505, lib: { f16: "Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm", f32: "Qwen2.5-3B-Instruct-q4f32_1_cs1k-webgpu.wasm" } },
  { key: "7B", label: "Coder 7B", note: "Gaming PCs (best)", gb: 4.5, ctx: 16384, maxReply: 4096, vramMB: 5107, lib: { f16: "Qwen2-7B-Instruct-q4f16_1_cs1k-webgpu.wasm", f32: "Qwen2-7B-Instruct-q4f32_1_cs1k-webgpu.wasm" } },
];

export function mlcId(model, precision) {
  return `Qwen2.5-Coder-${model.key}-Instruct-${precision === "f16" ? "q4f16_1" : "q4f32_1"}-MLC`;
}

const REMOTE = "https://huggingface.co/mlc-ai/";

/** Models shipped with this site, listed in models/index.json by the deploy workflow. */
let shipped = null;
async function isPreinstalled(id) {
  if (!shipped) {
    shipped = fetch(new URL("models/index.json", location.href), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return (await shipped).includes(id);
}

export async function modelRecord(model, precision) {
  const id = mlcId(model, precision);
  const local = await isPreinstalled(id);
  return {
    record: {
      model: local ? new URL(`models/${id}/`, location.href).href : REMOTE + id,
      model_id: id,
      model_lib: new URL(`libs/${model.lib[precision]}`, location.href).href,
      vram_required_MB: model.vramMB,
      low_resource_required: model.key !== "7B",
      overrides: { context_window_size: model.ctx },
    },
    preinstalled: local,
  };
}

/** What this device can run, and a sensible default model. */
export async function detectDevice() {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (new URLSearchParams(location.search).has("mock")) return { ok: true, mobile, precision: "f16", defaultKey: mobile ? "1.5B" : "7B" };
  if (!("gpu" in navigator)) return { ok: false, mobile, reason: "no-webgpu" };
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {}
  if (!adapter) return { ok: false, mobile, reason: "no-adapter" };
  const precision = adapter.features.has("shader-f16") ? "f16" : "f32";
  const defaultKey = mobile ? "1.5B" : "7B";
  return { ok: true, mobile, precision, defaultKey };
}
