"""Byte-level BPE tokenizer, written from scratch.

The JavaScript port in public/tokenizer.js must split text exactly the same
way, so the pre-tokenizer is a tiny hand-written state machine, not a regex.
"""

import json
from collections import Counter

SPECIALS = ["<|user|>", "<|bot|>", "<|end|>"]
USER, BOT, END = 256, 257, 258
FIRST_MERGE_ID = 256 + len(SPECIALS)


def is_word(c):
    return c.isascii() and (c.isalnum() or c == "_")


def pretokenize(text):
    """Split text into chunks. A single space sticks to the word/symbol after it."""
    chunks, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == "\n":
            chunks.append("\n")
            i += 1
        elif c == " ":
            j = i
            while j < n and text[j] == " ":
                j += 1
            if j < n and text[j] != "\n":
                # Leave the last space to attach to the next chunk.
                if j - 1 > i:
                    chunks.append(text[i : j - 1])
                i = j - 1
                start = i
                i += 1
                if is_word(text[i]):
                    while i < n and is_word(text[i]):
                        i += 1
                else:
                    i += 1
                chunks.append(text[start:i])
            else:
                chunks.append(text[i:j])
                i = j
        elif is_word(c):
            j = i
            while j < n and is_word(text[j]):
                j += 1
            chunks.append(text[i:j])
            i = j
        else:
            chunks.append(c)
            i += 1
    return chunks


class Tokenizer:
    def __init__(self, merges):
        # merges: list of (a, b) token-id pairs; merge k creates id FIRST_MERGE_ID + k
        self.merges = merges
        self.ranks = {pair: k for k, pair in enumerate(merges)}
        self.vocab = {i: bytes([i]) for i in range(256)}
        for i, s in enumerate(SPECIALS):
            self.vocab[256 + i] = s.encode()
        for k, (a, b) in enumerate(merges):
            self.vocab[FIRST_MERGE_ID + k] = self.vocab[a] + self.vocab[b]
        self.cache = {}

    @property
    def vocab_size(self):
        return FIRST_MERGE_ID + len(self.merges)

    def encode_chunk(self, chunk):
        if chunk in self.cache:
            return self.cache[chunk]
        ids = list(chunk.encode("utf-8"))
        while len(ids) > 1:
            best, best_rank = None, None
            for k in range(len(ids) - 1):
                r = self.ranks.get((ids[k], ids[k + 1]))
                if r is not None and (best_rank is None or r < best_rank):
                    best, best_rank = k, r
            if best is None:
                break
            ids[best : best + 2] = [FIRST_MERGE_ID + best_rank]
        if len(self.cache) < 200_000:
            self.cache[chunk] = ids
        return ids

    def encode(self, text):
        out = []
        for chunk in pretokenize(text):
            out.extend(self.encode_chunk(chunk))
        return out

    def decode(self, ids):
        return b"".join(self.vocab[i] for i in ids).decode("utf-8", errors="replace")

    def save(self, path):
        with open(path, "w") as f:
            json.dump({"specials": SPECIALS, "merges": self.merges}, f)

    @classmethod
    def load(cls, path):
        with open(path) as f:
            return cls([tuple(m) for m in json.load(f)["merges"]])


def train_bpe(texts, vocab_size):
    """Classic BPE over unique pre-tokenized chunks, weighted by frequency."""
    counts = Counter()
    for t in texts:
        counts.update(pretokenize(t))
    words = [list(w.encode("utf-8")) for w in counts]
    freqs = list(counts.values())

    # Incremental pair counts: only words containing the merged pair are revisited.
    pairs = Counter()
    where = {}
    for wi, ids in enumerate(words):
        for k in range(len(ids) - 1):
            p = (ids[k], ids[k + 1])
            pairs[p] += freqs[wi]
            where.setdefault(p, set()).add(wi)

    merges = []
    num_merges = vocab_size - FIRST_MERGE_ID
    for step in range(num_merges):
        if not pairs:
            break
        # Ties broken by the pair itself so the result is deterministic.
        (a, b), freq = max(pairs.items(), key=lambda kv: (kv[1], kv[0]))
        if freq < 2:
            break
        new_id = FIRST_MERGE_ID + len(merges)
        merges.append((a, b))
        for wi in list(where.get((a, b), ())):
            ids, f = words[wi], freqs[wi]
            for k in range(len(ids) - 1):
                p = (ids[k], ids[k + 1])
                pairs[p] -= f
                if pairs[p] <= 0:
                    del pairs[p]
                where[p].discard(wi)
            k, out = 0, []
            while k < len(ids):
                if k < len(ids) - 1 and ids[k] == a and ids[k + 1] == b:
                    out.append(new_id)
                    k += 2
                else:
                    out.append(ids[k])
                    k += 1
            words[wi] = out
            for k in range(len(out) - 1):
                p = (out[k], out[k + 1])
                pairs[p] += f
                where.setdefault(p, set()).add(wi)
        if step % 500 == 0:
            print(f"bpe merge {step}/{num_merges} freq={freq}", flush=True)
    return Tokenizer(merges)
