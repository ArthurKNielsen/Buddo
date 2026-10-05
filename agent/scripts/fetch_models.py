"""Download models into the site so they're "preinstalled" (run by the deploy workflow).

Usage: python scripts/fetch_models.py MODEL_ID [MODEL_ID ...]
Files land in models/<id>/resolve/main/, the layout WebLLM expects, and
models/index.json lists what was shipped. A model is skipped if it would push
the site past GitHub Pages' 1 GB limit (the app then downloads it from the
model host instead).
"""

import json
import os
import sys
import urllib.request

HOST = "https://huggingface.co"
SITE_LIMIT = 990 * 1024 * 1024


def get_json(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def site_size(root="."):
    total = 0
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in (".git", "node_modules")]
        total += sum(os.path.getsize(os.path.join(d, f)) for f in files)
    return total


def main():
    shipped = []
    for model_id in sys.argv[1:]:
        files = [f for f in get_json(f"{HOST}/api/models/mlc-ai/{model_id}/tree/main") if f["type"] == "file"]
        size = sum(f.get("size", 0) for f in files)
        if site_size() + size > SITE_LIMIT:
            print(f"skip {model_id}: {size / 1e6:.0f} MB would exceed the Pages size limit")
            continue
        dest = os.path.join("models", model_id, "resolve", "main")
        for f in files:
            out = os.path.join(dest, f["path"])
            os.makedirs(os.path.dirname(out), exist_ok=True)
            urllib.request.urlretrieve(f"{HOST}/mlc-ai/{model_id}/resolve/main/{f['path']}", out)
        print(f"shipped {model_id}: {len(files)} files, {size / 1e6:.0f} MB")
        shipped.append(model_id)
    with open(os.path.join("models", "index.json"), "w") as fh:
        json.dump(shipped, fh)


if __name__ == "__main__":
    main()
