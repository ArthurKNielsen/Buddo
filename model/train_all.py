"""Train Buddo start to finish with one command, on any computer.

    python train_all.py                          # small model, ~2.5 hours on a CPU
    python train_all.py --size medium --code-mb 300 --pretrain 120 --finetune 10   # with a GPU

Steps: collect Python code -> tokenizer + datasets -> pretrain -> fine-tune ->
exam -> copy the model into ../public so the app uses it.
Each step is skipped if its output already exists, so you can stop and rerun.
"""

import argparse
import os
import shutil
import site
import subprocess
import sys
import sysconfig

HERE = os.path.dirname(os.path.abspath(__file__))


def run(*args):
    print("\n$ python " + " ".join(args), flush=True)
    subprocess.run([sys.executable, *args], cwd=HERE, check=True)


def code_sources():
    """Python code already on this computer: the standard library and installed packages."""
    dirs = [sysconfig.get_paths()["stdlib"]] + site.getsitepackages()
    return [d for d in dict.fromkeys(dirs) if os.path.isdir(d)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", default="small", choices=["small", "medium", "large"])
    ap.add_argument("--pretrain", type=float, default=90, help="minutes of pretraining")
    ap.add_argument("--finetune", type=float, default=40, help="minutes of fine-tuning")
    ap.add_argument("--work", default="work", help="folder for data and checkpoints")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--code-mb", type=float, default=70, help="MB of Python code to read (more helps bigger models)")
    ap.add_argument("--batch", type=int, default=48, help="lower it (e.g. 24) if the GPU runs out of memory")
    args = ap.parse_args()

    work = os.path.abspath(args.work)
    data, base, ft = (os.path.join(work, d) for d in ("data", "pretrained", "finetuned"))

    if not os.path.exists(os.path.join(data, "raw_train.bin")):
        print("Reading Python code from:", *code_sources(), sep="\n  ")
        os.environ["BUDDO_CODE_MB"] = str(args.code_mb)
        run("prepare.py", data, *code_sources())
    run("tasks.py", "--check")
    run("generators.py")
    run("tasks.py", data)

    if not os.path.exists(os.path.join(base, "ckpt.pt")):
        run("train.py", data, base, "--size", args.size, "--minutes", str(args.pretrain), "--device", args.device, "--batch", str(args.batch))
    run("train.py", data, ft, "--init", os.path.join(base, "ckpt.pt"), "--mix", "raw:1,sft:1,tasks:3",
        "--minutes", str(args.finetune), "--lr", "5e-4", "--warmup", "20", "--device", args.device,
        "--batch", str(args.batch))

    run("eval.py", data, os.path.join(ft, "ckpt.pt"))

    public = os.path.join(HERE, "..", "public")
    shutil.copy(os.path.join(data, "tokenizer.json"), public)
    shutil.copy(os.path.join(ft, "buddo-model.bin"), public)
    print("\nDone! Your model is in public/. Run `npm start` in the Buddo folder to chat with it.")


if __name__ == "__main__":
    main()
