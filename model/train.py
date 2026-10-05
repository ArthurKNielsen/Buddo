"""A small GPT-style transformer, written from scratch, trained on Python code.

Position info comes from ALiBi (a distance penalty inside attention) instead of
learned position embeddings, so the model can read prompts far longer than it
was trained on. That is what lets the app offer a 20,000-token context.

Usage: python train.py DATA_DIR OUT_DIR [--minutes 90]
"""

import argparse
import json
import math
import os
import struct
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CONFIG = dict(vocab_size=4096, n_layer=6, n_head=6, d_model=192, train_ctx=256)


def alibi_slopes(n_head):
    return [2 ** (-8 * (h + 1) / n_head) for h in range(n_head)]


class Block(nn.Module):
    def __init__(self, d, n_head):
        super().__init__()
        self.n_head = n_head
        self.ln1 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.proj = nn.Linear(d, d)
        self.ln2 = nn.LayerNorm(d)
        self.fc = nn.Linear(d, 4 * d)
        self.out = nn.Linear(4 * d, d)

    def forward(self, x, bias):
        B, T, C = x.shape
        h = self.ln1(x)
        q, k, v = self.qkv(h).split(C, dim=2)
        q, k, v = (t.view(B, T, self.n_head, C // self.n_head).transpose(1, 2) for t in (q, k, v))
        y = F.scaled_dot_product_attention(q, k, v, attn_mask=bias)
        x = x + self.proj(y.transpose(1, 2).reshape(B, T, C))
        x = x + self.out(F.gelu(self.fc(self.ln2(x)), approximate="tanh"))
        return x


class GPT(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg
        d = cfg["d_model"]
        self.embed = nn.Embedding(cfg["vocab_size"], d)
        self.blocks = nn.ModuleList(Block(d, cfg["n_head"]) for _ in range(cfg["n_layer"]))
        self.ln_f = nn.LayerNorm(d)
        self.register_buffer("slopes", torch.tensor(alibi_slopes(cfg["n_head"])), persistent=False)
        self.apply(self._init)
        for b in self.blocks:  # scale residual projections, as in GPT-2
            for lin in (b.proj, b.out):
                nn.init.normal_(lin.weight, std=0.02 / math.sqrt(2 * cfg["n_layer"]))

    @staticmethod
    def _init(m):
        if isinstance(m, (nn.Linear, nn.Embedding)):
            nn.init.normal_(m.weight, std=0.02)
        if isinstance(m, nn.Linear) and m.bias is not None:
            nn.init.zeros_(m.bias)

    def alibi(self, T, device):
        pos = torch.arange(T, device=device)
        dist = (pos[None, :] - pos[:, None]).float()  # key - query, <= 0 for the past
        bias = self.slopes[:, None, None] * dist[None]
        return bias.masked_fill(dist[None] > 0, float("-inf"))

    def forward(self, idx, targets=None):
        x = self.embed(idx)
        bias = self.alibi(idx.shape[1], idx.device)
        for b in self.blocks:
            x = b(x, bias)
        logits = self.ln_f(x) @ self.embed.weight.T  # tied output head
        if targets is None:
            return logits
        return F.cross_entropy(logits.reshape(-1, logits.size(-1)), targets.reshape(-1))


def batches(data_dir, split, batch, ctx):
    raw = np.memmap(os.path.join(data_dir, f"raw_{split}.bin"), dtype=np.uint16, mode="r")
    sft = np.memmap(os.path.join(data_dir, f"sft_{split}.bin"), dtype=np.uint16, mode="r")

    def take(arr, n):
        ix = np.random.randint(0, len(arr) - ctx - 1, n)
        return np.stack([arr[i : i + ctx + 1] for i in ix]).astype(np.int64)

    while True:
        half = batch // 2
        chunk = torch.from_numpy(np.concatenate([take(raw, batch - half), take(sft, half)]))
        yield chunk[:, :-1], chunk[:, 1:]


@torch.no_grad()
def evaluate(model, data_dir, batch, ctx, steps=10):
    model.eval()
    it = batches(data_dir, "val", batch, ctx)
    loss = sum(model(*next(it)).item() for _ in range(steps)) / steps
    model.train()
    return loss


def export(model, path):
    """BUDO file: magic, header length, JSON header, then float16 tensors."""
    tensors, blobs, offset = [], [], 0
    for name, t in model.state_dict().items():
        arr = t.detach().cpu().numpy().astype(np.float16)
        tensors.append({"name": name, "shape": list(arr.shape), "offset": offset})
        blobs.append(arr.tobytes())
        offset += arr.nbytes
    header = json.dumps({"config": model.cfg, "tensors": tensors}).encode()
    header += b" " * (-len(header) % 4)
    with open(path, "wb") as f:
        f.write(b"BUDO" + struct.pack("<I", len(header)) + header)
        for b in blobs:
            f.write(b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--minutes", type=float, default=90)
    ap.add_argument("--batch", type=int, default=48)
    ap.add_argument("--lr", type=float, default=1.5e-3)
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    torch.manual_seed(1337)
    np.random.seed(1337)
    torch.set_num_threads(os.cpu_count())

    model = GPT(CONFIG)
    ckpt_path = os.path.join(args.out_dir, "ckpt.pt")
    if args.resume and os.path.exists(ckpt_path):
        model.load_state_dict(torch.load(ckpt_path))
    print(f"{sum(p.numel() for p in model.parameters()) / 1e6:.2f}M parameters", flush=True)

    decay = [p for n, p in model.named_parameters() if p.dim() >= 2]
    no_decay = [p for n, p in model.named_parameters() if p.dim() < 2]
    opt = torch.optim.AdamW(
        [{"params": decay, "weight_decay": 0.1}, {"params": no_decay, "weight_decay": 0.0}],
        lr=args.lr, betas=(0.9, 0.95),
    )

    ctx = CONFIG["train_ctx"]
    it = batches(args.data_dir, "train", args.batch, ctx)
    budget = args.minutes * 60
    start = time.time()
    step, warmup = 0, 100
    while True:
        progress = (time.time() - start) / budget
        if progress >= 1:
            break
        lr = args.lr * min(1, (step + 1) / warmup) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * progress)))
        for g in opt.param_groups:
            g["lr"] = lr
        x, y = next(it)
        loss = model(x, y)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if step % 25 == 0:
            print(f"step {step} loss {loss.item():.3f} lr {lr:.2e} {time.time() - start:.0f}s", flush=True)
        if step % 250 == 0 and step > 0:
            print(f"  val loss {evaluate(model, args.data_dir, args.batch, ctx):.3f}", flush=True)
            torch.save(model.state_dict(), ckpt_path)
        step += 1

    print(f"final val loss {evaluate(model, args.data_dir, args.batch, ctx):.3f} after {step} steps", flush=True)
    torch.save(model.state_dict(), ckpt_path)
    export(model, os.path.join(args.out_dir, "buddo-model.bin"))
    print("exported", flush=True)


if __name__ == "__main__":
    main()
