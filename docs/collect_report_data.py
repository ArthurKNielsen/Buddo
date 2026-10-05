import json, re, random, sys
import numpy as np
sys.path.insert(0, "/home/user/Buddo/model")
from tokenizer import Tokenizer, USER, BOT, END, pretokenize
import train, tasks
from generators import FAMILIES, all_items

S = sys.argv[1]
tok = Tokenizer.load(f"{S}/data/tokenizer.json")

def curve(path):
    steps, val = [], []
    last = 0
    for line in open(path):
        m = re.match(r"step (\d+) loss ([\d.]+) lr \S+ (\d+)s", line)
        if m:
            last = int(m.group(1)); steps.append([last, float(m.group(2)), int(m.group(3))])
        m = re.match(r"\s*val loss ([\d.]+)", line)
        if m:
            val.append([last, float(m.group(1))])
        m = re.match(r"final val loss ([\d.]+) after (\d+) steps", line)
        if m:
            val.append([int(m.group(2)), float(m.group(1))])
    return {"train": steps, "val": val}

def decode_pairs(path, n, seed):
    arr = np.fromfile(path, dtype=np.uint16)
    starts = np.flatnonzero(arr == USER)
    rng = random.Random(seed)
    out = []
    for i in rng.sample(list(starts[:-1]), n * 3):
        seg = arr[i:i + 600].tolist()
        if BOT not in seg or END not in seg: continue
        b, e = seg.index(BOT), seg.index(END)
        if e < b: continue
        q, a = tok.decode(seg[1:b]), tok.decode(seg[b + 1:e])
        if len(a) > 700: continue
        out.append({"q": q, "a": a})
        if len(out) == n: break
    return out

raw = np.fromfile(f"{S}/data/raw_train.bin", dtype=np.uint16)
ends = np.flatnonzero(raw == END)
raw_text = None
for k in range(40, 200):
    t = tok.decode(raw[ends[k] + 1: ends[k] + 260].tolist())
    if t.lstrip().startswith(('"""', "#", "import", "from")):
        raw_text = t; break

demo = "write a python function to reverse a string"
ids = tok.encode(demo)
pieces = [tok.decode([i]) for i in ids]

ex = tasks.build_examples(random.Random(3), task_reps=1, chat_reps=1, gen_reps=1)
chat_q = {p for ps, _ in tasks.CHAT for p in ps}
task_samples = [e for e in ex if e[0].lower().rstrip("?!") not in chat_q][:8]

evals = {}
for name, d in (("v1", "eval-v1"), ("v2", "eval-v2")):
    try:
        r = json.load(open(f"{S}/{d}/eval_results.json"))
        evals[name] = list(r.values())[0]
    except FileNotFoundError:
        pass

data = {
    "config": train.CONFIG,
    "params": 3_460_000,
    "tokens": {"raw": int(raw.size), "sft": int(np.fromfile(f"{S}/data/sft_train.bin", dtype=np.uint16).size),
               "tasks": int(np.fromfile(f"{S}/data/tasks_train.bin", dtype=np.uint16).size)},
    "curves": {"pretrain": curve(f"{S}/train.log"), "ft1": curve(f"{S}/ft.log"), "ft2": curve(f"{S}/ft2.log")},
    "raw_sample": raw_text,
    "lib_pairs": decode_pairs(f"{S}/data/sft_train.bin", 3, 1),
    "task_samples": [{"q": q, "a": a} for q, a in task_samples],
    "chat": [{"q": ps[0], "a": rs[0]} for ps, rs in tasks.CHAT],
    "families": [{"name": f.__name__, "count": len(f())} for f in FAMILIES],
    "hand_tasks": len(tasks.TASKS),
    "templates": tasks.ASK_TEMPLATES,
    "tok_demo": {"text": demo, "pieces": pieces, "ids": ids},
    "vocab": tok.vocab_size,
    "evals": evals,
}
json.dump(data, open(f"{S}/report-data.json", "w"))
print("ok", {k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in data.items()})
