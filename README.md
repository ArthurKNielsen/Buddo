# Buddo (from scratch)

Buddo is a tiny AI that writes Python, built completely from scratch. It doesn't use Ollama, Hugging Face, `transformers`, or any pretrained model.

- **The model** is a small GPT-style transformer (3.5M parameters) written by hand in `model/train.py`. It was trained on Python source code: the standard library plus open-source packages.
- **The tokenizer** is a byte-level BPE tokenizer written by hand in `model/tokenizer.py`.
- **On your phone**, the model runs locally in the browser with a hand-written JavaScript engine (`public/worker.js`) that uses zero libraries. Once it's loaded, chatting needs no internet, no server, and no API key, and it's free.
- **20,000-token context window.** Buddo uses ALiBi attention, so it can read prompts much longer than it was trained on. When a chat grows past 20k tokens, the oldest messages are dropped.

## How smart is it?

Buddo is about 100,000× smaller than models like ChatGPT. It was pretrained for 90 minutes on a CPU, then fine-tuned for 40 minutes on 63 hand-written tasks (`model/tasks.py`), 299 generated programs (`model/generators.py`) and simple chat. Every training answer is run and checked first.

**Exam score:** 47 generated programs are held out and never trained on. `model/eval.py` asks Buddo for each one, runs its code in a sandbox, and checks the result. v1 passed 1/47 (2%). v2 passes 15/47 (32%). Results are in `docs/exam-results-v2.json`, and the full training write-up is `docs/how-buddo-learns.html`.

- **Everyday tasks** (reverse a string, primes, factorial, fizzbuzz, sorting, files and JSON, a guessing game, a calculator, and more): it writes correct code, however you phrase the ask.
- **Chat** ("hi", "who are you", "thanks"): it answers in words. For off-topic questions it says it only knows Python.
- **Anything else:** it picks the closest thing it knows, so expect wrong answers. Adding more tasks to `model/tasks.py` and fine-tuning again teaches it more.

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
python tasks.py --check                                                 # run every task solution
python tasks.py data                                                    # build the everyday-tasks dataset
python train.py data out --minutes 90                                   # pretrain on code (CPU)
python generators.py                                                    # build + verify generated programs
python train.py data ft --init out/ckpt.pt --mix raw:1,sft:1,tasks:3 --minutes 40 --lr 5e-4 --warmup 20
python eval.py data ft/ckpt.pt                                          # the exam
python sample.py data ft/ckpt.pt "hi" "reverse a string"                # spot check
cp data/tokenizer.json ft/buddo-model.bin ../public/
```

## Files

| Path | What it is |
|---|---|
| `model/tokenizer.py` | BPE tokenizer: training, encoding, decoding |
| `model/prepare.py` | Collects code, extracts "description → function" pairs, builds datasets |
| `model/tasks.py` | 63 verified everyday tasks + chat replies used for fine-tuning |
| `model/generators.py` | 299 generated programs across 10 families, each verified |
| `model/eval.py` | The exam: held-out programs, answers run in a sandbox |
| `docs/how-buddo-learns.html` | Training write-up with data samples, loss curves and exam results |
| `model/sample.py` | Chat with a checkpoint in the terminal |
| `model/train.py` | The transformer and the training loop; exports `buddo-model.bin` (float16) |
| `public/worker.js` | Runs the model in the browser: tokenizer, transformer, sampling, KV cache |
| `public/app.js` | Chat UI |
| `scripts/build-artifact.mjs` | Packs `public/` into one page for hosting as a claude.ai artifact |
