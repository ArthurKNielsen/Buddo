"""The exam: ask Buddo for programs it never trained on, run its code, check the result.

Usage: python eval.py DATA_DIR CKPT [CKPT ...]

Each answer runs in a separate process with a time limit, input() disabled and
no network, so a broken or looping answer just counts as a fail.
"""

import json
import subprocess
import sys

import torch

import train
from generators import all_items
from sample import reply
from tasks import held_out
from tokenizer import Tokenizer

RUNNER = r'''
import ast, builtins, contextlib, io, json, math, sys
spec = json.loads(sys.stdin.read())
builtins.input = lambda *a: (_ for _ in ()).throw(RuntimeError("no input in the exam"))
buf = io.StringIO()
env = {}
try:
    with contextlib.redirect_stdout(buf):
        exec(spec["code"], env)
    kind = spec["check"][0]
    if kind == "func":
        _, name, cases = spec["check"]
        fn = env.get(name)
        if fn is None:  # Buddo may pick its own function name: use the first one it defined
            defs = [n.name for n in ast.parse(spec["code"]).body if isinstance(n, ast.FunctionDef)]
            fn = env[defs[0]]
        ok = True
        for args, expected in cases:
            with contextlib.redirect_stdout(io.StringIO()):
                got = fn(*args)
            if isinstance(expected, float) and isinstance(got, (int, float)):
                ok &= math.isclose(got, expected, rel_tol=1e-6)
            else:
                ok &= json.dumps(got, sort_keys=True, default=str) == json.dumps(expected, sort_keys=True, default=str)
    elif kind == "out":
        ok = buf.getvalue() == spec["check"][1]
    else:
        ok = bool(eval(spec["check"][1], env))
except Exception:
    ok = False
print("PASS" if ok else "FAIL")
'''


def run(code, check):
    # Tuples become lists in JSON; compare on the JSON form on both sides.
    spec = json.dumps({"code": code, "check": check}, default=list)
    try:
        out = subprocess.run([sys.executable, "-c", RUNNER], input=spec, capture_output=True, text=True, encoding="utf-8", timeout=5)
        return out.stdout.strip().endswith("PASS")
    except subprocess.TimeoutExpired:
        return False


def exam_questions():
    return [(f"write a python function to {it['asks'][0]}", it) for it in held_out(all_items())]


def main():
    data_dir, ckpts = sys.argv[1], sys.argv[2:]
    tok = Tokenizer.load(f"{data_dir}/tokenizer.json")
    questions = exam_questions()
    results = {}
    for ckpt in ckpts:
        torch.manual_seed(0)
        model = train.load_model(ckpt)
        model.eval()
        passed, log = 0, []
        for prompt, item in questions:
            answer = reply(model, tok, prompt, max_new=300, temperature=0.2)
            ok = run(answer, item["check"])
            passed += ok
            log.append({"prompt": prompt, "answer": answer, "pass": ok})
        results[ckpt] = {"passed": passed, "total": len(questions), "log": log}
        print(f"{ckpt}: {passed}/{len(questions)} held-out programs work ({passed / len(questions):.0%})", flush=True)
    with open(f"{data_dir}/eval_results.json", "w") as f:
        json.dump(results, f, indent=1)


if __name__ == "__main__":
    main()
