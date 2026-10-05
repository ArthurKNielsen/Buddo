# Buddo (from scratch)

Buddo is a tiny AI that writes Python, built completely from scratch. It doesn't use Ollama, Hugging Face, `transformers`, or any pretrained model.

- **The model** is a small GPT-style transformer (3.5M parameters) written by hand in `model/train.py`. It was trained on Python source code: the standard library plus open-source packages.
- **The tokenizer** is a byte-level BPE tokenizer written by hand in `model/tokenizer.py`.
- **On your phone**, the model runs locally in the browser with a hand-written JavaScript engine (`public/worker.js`) that uses zero libraries. Once it's loaded, chatting needs no internet, no server, and no API key, and it's free.
- **20,000-token context window.** Buddo uses ALiBi attention, so it can read prompts much longer than it was trained on. When a chat grows past 20k tokens, the oldest messages are dropped.

## How smart is it?

Expectations: Buddo is about 100,000× smaller than models like ChatGPT and was trained for about 90 minutes on a laptop-class CPU. It writes Python that *looks* right, with real syntax, idioms, and function shapes, but the logic is often wrong and it can't really hold a conversation. It works best when you describe one function, docstring style, for example:

> Return the sum of the squares of a list of numbers.

Bigger models, more data, and longer training make it better. Everything you need to retrain is in `model/`.

## Use it

**On your phone:** open the hosted link and tap Share → *Add to Home Screen*.

**On your computer:**

```bash
npm start
```

Then open http://localhost:3000. Phones on the same Wi-Fi can use the `On your phone` link it prints.

You can host the `public/` folder on any static web host. There's nothing to run server-side.

## Retrain the model

Needs Python 3 with `torch` and `numpy` (PyTorch is only used for training math; the model code is ours).

```bash
cd model
python prepare.py data /usr/lib/python3.12 /path/to/more/python/code   # tokenizer + datasets
python train.py data out --minutes 90                                   # train on CPU
cp data/tokenizer.json out/buddo-model.bin ../public/
```

## Files

| Path | What it is |
|---|---|
| `model/tokenizer.py` | BPE tokenizer: training, encoding, decoding |
| `model/prepare.py` | Collects code, extracts "description → function" pairs, builds datasets |
| `model/train.py` | The transformer and the training loop; exports `buddo-model.bin` (float16) |
| `public/worker.js` | Runs the model in the browser: tokenizer, transformer, sampling, KV cache |
| `public/app.js` | Chat UI |
| `scripts/build-artifact.mjs` | Packs `public/` into one page for hosting as a claude.ai artifact |
