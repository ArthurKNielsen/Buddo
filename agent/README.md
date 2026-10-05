# Buddo Agent

A free coding agent that runs **entirely in your browser**. Ask it to build a website, watch the live preview, then ask for changes. It edits only the lines that need to change.

- **100% free, for everyone.** The AI (Qwen2.5-Coder, Apache-2.0) runs on your own device's graphics chip through WebGPU. No accounts, no API keys, no servers, no tokens.
- **Download once, instant after.** The model is saved in your browser after the first load and works offline. The phone model ships with the site itself.
- **Only the needed lines change, guaranteed.** The agent has no way to rewrite an existing file. Every change is a SEARCH/REPLACE edit that quotes the exact lines to replace, and the app applies only those, whatever the file size. Edits that try to rewrite a file get refused and retried.

## Models

| Model | Download | Best for |
|---|---|---|
| Coder 0.5B | ~0.4 GB | Older phones |
| Coder 1.5B | ~1 GB (ships with the site) | Phones (default) |
| Coder 3B | ~1.8 GB | Laptops, strong phones |
| Coder 7B | ~4.5 GB | Gaming PCs (default on computers, best) |

Needs a browser with WebGPU: Chrome or Edge on a computer or Android, or Safari on iOS 26+.

## How it works

| File | Job |
|---|---|
| `src/edits.js` | Parses SEARCH/REPLACE blocks and applies them; refuses rewrites |
| `src/prompt.js` | Rules for the model, plus fitting chat and files into its context |
| `src/app.js` | Chat, agent loop (retries failed edits), undo, files, preview |
| `src/engine.js` | Runs the model in a background worker ([WebLLM](https://github.com/mlc-ai/web-llm), vendored in `vendor/`) |
| `src/preview.js` | Live preview with local CSS/JS inlined |
| `src/store.js` | Projects saved in the browser (IndexedDB) |
| `libs/` | The models' compiled WebGPU code |
| `scripts/fetch_models.py` | Deploy step that copies the phone model into the site |

Run locally with `npm start` and open http://localhost:8080. Add `?mock` to the address to try the interface without a GPU. Tests: `npm test`.

## Deploying

Pushes to `main` deploy to GitHub Pages through `.github/workflows/pages.yml`. One-time setup: **Settings → Pages → Source: GitHub Actions**.
