"""Build the training data: raw Python code + (instruction -> function) pairs.

Usage: python prepare.py OUT_DIR SOURCE_DIR [SOURCE_DIR ...]
Every *.py file under the source dirs is used (e.g. the Python standard library).
"""

import ast
import hashlib
import os
import random
import sys
from multiprocessing import Pool

import numpy as np

from tokenizer import BOT, END, USER, Tokenizer, train_bpe

VOCAB_SIZE = 4096
MAX_CODE_BYTES = 70_000_000
random.seed(1337)

TEMPLATES = [
    "Write a Python function that does this: {doc}",
    "{doc}",
    "Write a function called {name}. {doc}",
    "Python code please: {doc}",
    "Can you write Python for this? {doc}",
    "write a python function to {lower}",
]

# A few hand-written turns so Buddo knows who it is.
CHAT = [
    ("hi", "Hey! I'm Buddo, a tiny Python model trained from scratch. Describe a function and I'll try to write it."),
    ("hello", "Hi! I'm Buddo. Tell me what Python function you need."),
    ("hey", "Hey gng! What should I code?"),
    ("who are you", "I'm Buddo, a small language model built from scratch. I only know Python code."),
    ("what can you do", "I write Python functions. Describe what it should do, like: return the sum of a list."),
    ("thanks", "No problem! Want another function?"),
    ("thank you", "Anytime! What's next?"),
]


def collect_files(dirs):
    seen, files = set(), []
    for d in dirs:
        for root, _, names in os.walk(d):
            for name in sorted(names):
                if not name.endswith(".py"):
                    continue
                path = os.path.join(root, name)
                try:
                    text = open(path, encoding="utf-8").read()
                except (UnicodeDecodeError, OSError):
                    continue
                if not (200 < len(text) < 300_000):
                    continue
                if max(map(len, text.splitlines() or [""])) > 300:
                    continue  # generated or minified code
                h = hashlib.sha1(text.encode()).hexdigest()
                if h in seen:
                    continue
                seen.add(h)
                files.append(text.replace("\t", "    ").replace("\r", ""))
    random.shuffle(files)
    return files


def first_paragraph(doc):
    para = doc.strip().split("\n\n")[0]
    return " ".join(line.strip() for line in para.splitlines()).strip()


def extract_pairs(text):
    """(instruction, function source without its docstring) for documented functions."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return []
    lines = text.splitlines()
    pairs = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        doc = ast.get_docstring(node)
        if not doc or node.name.startswith("test"):
            continue
        summary = first_paragraph(doc)
        if not (15 <= len(summary) <= 300) or ">>>" in summary:
            continue
        start = (node.decorator_list[0].lineno if node.decorator_list else node.lineno) - 1
        doc_node = node.body[0]
        body = lines[start : doc_node.lineno - 1] + lines[doc_node.end_lineno : node.end_lineno]
        if len(node.body) < 2:
            continue
        indent = len(body[0]) - len(body[0].lstrip())
        code = "\n".join(l[indent:] if len(l) >= indent else l.strip() for l in body).strip("\n")
        if not (40 <= len(code) <= 1800):
            continue
        tmpl = random.choice(TEMPLATES)
        lower = summary[0].lower() + summary[1:].rstrip(".")
        pairs.append((tmpl.format(doc=summary, name=node.name, lower=lower), code))
    return pairs


tok = None


def init_worker(path):
    global tok
    tok = Tokenizer.load(path)


def encode_text(text):
    return tok.encode(text)


def encode_pair(pair):
    q, a = pair
    return [USER] + tok.encode(q) + [BOT] + tok.encode(a) + [END]


def main():
    out_dir, dirs = sys.argv[1], sys.argv[2:]
    os.makedirs(out_dir, exist_ok=True)

    files = collect_files(dirs)
    total, code = 0, []
    for f in files:
        if total > MAX_CODE_BYTES:
            break
        code.append(f)
        total += len(f)
    print(f"{len(code)} files, {total / 1e6:.1f} MB of code")

    pairs = [p for f in code for p in extract_pairs(f)]
    random.shuffle(pairs)
    pairs += CHAT * 40
    random.shuffle(pairs)
    print(f"{len(pairs)} instruction pairs")
    for q, a in pairs[:3]:
        print("---\n", q, "\n", a[:300])

    tok_path = os.path.join(out_dir, "tokenizer.json")
    sample = code[: max(1, len(code) // 6)] + [q for q, _ in pairs[:20000]]
    train_bpe(sample, VOCAB_SIZE).save(tok_path)

    with Pool(os.cpu_count(), initializer=init_worker, initargs=(tok_path,)) as pool:
        raw = pool.map(encode_text, code, chunksize=16)
        sft = pool.map(encode_pair, pairs, chunksize=256)

    def write(name, seqs, sep):
        flat = []
        for s in seqs:
            flat.extend(s)
            if sep is not None:
                flat.append(sep)
        arr = np.array(flat, dtype=np.uint16)
        arr.tofile(os.path.join(out_dir, name))
        print(f"{name}: {len(arr) / 1e6:.1f}M tokens")

    n_val = max(1, len(raw) // 50)
    write("raw_train.bin", raw[n_val:], END)
    write("raw_val.bin", raw[:n_val], END)
    n_val = max(1, len(sft) // 50)
    write("sft_train.bin", sft[n_val:], None)
    write("sft_val.bin", sft[:n_val], None)


if __name__ == "__main__":
    main()
