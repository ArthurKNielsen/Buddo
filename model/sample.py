"""Chat with a trained checkpoint from the terminal (handy for spot checks).

Usage: python sample.py DATA_DIR CKPT "prompt one" "prompt two" ...
"""

import sys

import torch

import train
from tokenizer import BOT, END, USER, Tokenizer


@torch.no_grad()
def reply(model, tok, prompt, max_new=200, temperature=0.5, top_k=40):
    ids = [USER] + tok.encode(prompt) + [BOT]
    out = []
    for _ in range(max_new):
        logits = model(torch.tensor([ids[-1024:]]))[0, -1] / temperature
        v, ix = torch.topk(logits, top_k)
        nxt = ix[torch.multinomial(torch.softmax(v, -1), 1)].item()
        if nxt in (END, USER, BOT):
            break
        ids.append(nxt)
        out.append(nxt)
    return tok.decode(out)


def main():
    data_dir, ckpt, prompts = sys.argv[1], sys.argv[2], sys.argv[3:]
    torch.manual_seed(0)
    model = train.GPT(train.CONFIG)
    model.load_state_dict(torch.load(ckpt))
    model.eval()
    tok = Tokenizer.load(f"{data_dir}/tokenizer.json")
    for p in prompts:
        print(f">>> {p}\n{reply(model, tok, p)}\n")


if __name__ == "__main__":
    main()
