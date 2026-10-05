# Train Buddo on your home PC

## What you need

- **Any Windows, Mac or Linux computer.** A CPU alone works, it's just slower.
- **Python 3.10 or newer** from [python.org](https://www.python.org/downloads/). On Windows, tick **"Add python.exe to PATH"** in the installer.
- **Git** from [git-scm.com](https://git-scm.com/downloads), plus **Node.js** from [nodejs.org](https://nodejs.org/) for the chat app.
- **About 8 GB of free disk space** (most of it is PyTorch) and 8 GB+ of RAM. See [How much space it takes](#how-much-space-it-takes).

| Your computer | Pick | Rough time | Model |
|---|---|---|---|
| Any laptop/desktop (CPU only) | `--size small` | 2–3 h | 3.5M params, same as the hosted Buddo |
| NVIDIA graphics card (GTX 1060 / RTX or newer) | `--size medium` | ~1.5 h | 16M params, ~5× bigger |
| Apple Silicon Mac (M1–M4) | `--size medium` | 2–3 h | 16M params |
| NVIDIA RTX 3080 / 4070 or better | `--size large` | 2–4 h | 50M params, ~15× bigger |

## 1. Get the code

```bash
git clone -b buddo-from-scratch https://github.com/ArthurKNielsen/Buddo.git
cd Buddo/model
```

## 2. Install the training tools

```bash
python -m venv venv
# Windows:
venv\Scripts\activate
# Mac / Linux:
source venv/bin/activate

pip install numpy torch
```

**NVIDIA card on Windows or Linux:** install the GPU build of PyTorch instead (pick your CUDA version on [pytorch.org](https://pytorch.org/get-started/locally/)), for example:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu124
```

Check that it sees your graphics card:

```bash
python -c "import torch; print('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')"
```

It should print `cuda` (NVIDIA) or `mps` (Mac). `cpu` means it'll work, just slower.

## 3. Train, all in one command

```bash
# CPU only
python train_all.py

# NVIDIA GPU or Apple Silicon
python train_all.py --size medium --pretrain 60 --finetune 30

# Strong NVIDIA GPU
python train_all.py --size large --pretrain 120 --finetune 40
```

This runs every step: it reads the Python code already on your computer, builds the tokenizer, pretrains, fine-tunes on the verified tasks, takes the exam, and copies the finished model into `public/`. Progress prints as it goes. If you stop it, run the same command again and it skips the steps that are already done.

The last lines show the exam score, e.g. `15/47 held-out programs work (32%)`. Compare sizes and settings with that number.

### Recipe: RTX 3060

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install numpy
# more Python code for Buddo to read (bigger models need more data):
pip install django sympy pandas scikit-learn matplotlib flask requests rich
python train_all.py --size medium --code-mb 300 --pretrain 120 --finetune 10
```

- **Laptop 3060 (6 GB)** or a `CUDA out of memory` error: add `--batch 24`.
- **Medium beats large on a 3060.** A 50M-parameter model needs far more code than your PC has to read, so it mostly memorizes. Medium (16M) is the sweet spot.
- **Keep fine-tuning short on a GPU.** The task set is small, and a GPU loops over it fast. Much past 10 minutes it starts memorizing instead of learning patterns, which can lower the exam score. To try another fine-tune length, delete `work/finetuned` and rerun; pretraining is skipped.
- **Starting over:** delete the `work` folder. To redo only training, delete `work/pretrained` and `work/finetuned`.

## 4. Chat with your model

```bash
cd ..
npm start
```

Open http://localhost:3000. Your phone can use the `On your phone` link it prints, as long as it's on the same Wi-Fi.

**Size limit for the hosted claude.ai link:** it can only carry the small model. Medium and large models are too big for it, so use `npm start` for those, or put the `public/` folder on any static web host.

## How much space it takes

For the RTX 3060 recipe (medium model, 300 MB of code):

| What | Size |
|---|---|
| PyTorch with CUDA (the biggest part) | ~4.5 GB |
| pip's download cache (free it after: `pip cache purge`) | ~2.5 GB |
| Extra packages for code (django, pandas…) | ~0.5 GB |
| Python + Git + Node.js | ~0.6 GB |
| Buddo repo | 20 MB |
| Training data (`work/data`) | ~0.25 GB |
| Checkpoints and finished model (`work/`, `public/`) | ~0.25 GB |
| **Total** | **~8.5 GB, ~6 GB after `pip cache purge`** |

Buddo itself is only about **0.5 GB** of that, and the finished medium model is **32 MB**. While training it uses about 2–3 GB of RAM and 4–6 GB of graphics memory.

## Making it smarter

- **Train longer:** raise `--pretrain`. Loss keeps dropping for a long time on bigger models.
- **Add your own tasks:** add entries to `TASKS` in `model/tasks.py`, or a new family in `model/generators.py`. Run `python tasks.py --check` to confirm your solutions work, then fine-tune again.
- **More code to read:** `pip install` some pure-Python packages (e.g. `requests flask rich`) before step 3 and delete `work/data` so it re-reads them.
