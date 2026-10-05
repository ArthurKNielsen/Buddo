import { CreateWebWorkerMLCEngine, hasModelInCache } from "../vendor/web-llm.js";

export { hasModelInCache };

/** Load a model in a worker. onProgress({text, progress}) fires while it downloads/compiles. */
export async function loadEngine(record, onProgress) {
  if (new URLSearchParams(location.search).has("mock")) return mockEngine(onProgress);
  // Ask the browser not to evict the downloaded model when space gets tight.
  try {
    await navigator.storage?.persist?.();
  } catch {}
  const worker = new Worker(new URL("./engine-worker.js", import.meta.url), { type: "module" });
  return CreateWebWorkerMLCEngine(worker, record.model_id, {
    appConfig: { model_list: [record] },
    initProgressCallback: onProgress,
  });
}

/** Stream a reply. onText(fullTextSoFar). Resolves with the full text. */
export async function streamReply(engine, messages, { maxReply, onText }) {
  const chunks = await engine.chat.completions.create({
    messages,
    stream: true,
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: maxReply,
  });
  let text = "";
  let finish = null;
  for await (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      text += choice.delta.content;
      onText(text);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  return { text, truncated: finish === "length" };
}

// For testing the app without a GPU: ?mock in the URL. Replies come from
// window.buddoMockReplies (an array, consumed in order) or a canned website.
function mockEngine(onProgress) {
  onProgress({ text: "Mock model ready", progress: 1 });
  let stop = false;
  return {
    interruptGenerate() {
      stop = true;
    },
    chat: {
      completions: {
        async create() {
          stop = false;
          const reply = (window.buddoMockReplies || []).shift() ?? "Mock reply.";
          window.buddoMockSeen = (window.buddoMockSeen || 0) + 1;
          return (async function* () {
            for (let i = 0; i < reply.length && !stop; i += 12) {
              await new Promise((r) => setTimeout(r, 5));
              yield { choices: [{ delta: { content: reply.slice(i, i + 12) } }] };
            }
            yield { choices: [{ delta: {}, finish_reason: "stop" }] };
          })();
        },
      },
    },
  };
}
