<div align="center">

<img src="apps/desktop/icon.png" width="96" alt="Buddo logo" />

# Buddo

**A free, local-first AI coding agent. No API keys. No subscriptions. Your code never leaves your machine.**

Web app · Desktop app · Terminal CLI

**[🌐 Try Buddo in your browser](https://arthurknielsen.github.io/buddo/app)** — works on iPhone too: open it in Safari, then tap **Share → Add to Home Screen**.

</div>

---

Buddo is an open-source alternative to paid AI coding agents. It explores your codebase, plans multi-step work with a live todo list, edits files (with diffs you approve), runs your tests and commands, and iterates until the job is done. Everything runs on **free, open-weight models on your own computer**.

## ✨ Features

| | |
|---|---|
| 🆓 **Free forever** | Runs open models (Qwen, Llama, DeepSeek, gpt-oss…) through Ollama, LM Studio, llama.cpp, or right in your browser via WebGPU. No API keys. |
| 🤖 **Agentic** | Reads, searches, writes and edits files, runs shell commands, fetches docs, and checks its work. Works with any model thanks to a robust text-based tool protocol. |
| 🔐 **Permission modes** | **Ask** (approve every edit & command), **Auto** (auto-edit, approve commands), **YOLO** (approve all), **Plan** (read-only). `Shift+Tab` cycles. |
| 🧾 **Diffs + one-click revert** | Every change gets a syntax-highlighted diff. The Changes panel can revert any file — or everything. |
| 🖥️ **Integrated terminal** | Watch commands Buddo runs, or run your own. |
| 👀 **Live preview** | Building a website? It renders next to the chat as Buddo writes it. |
| ✅ **Live task list** | For bigger jobs Buddo writes a plan and checks items off as it goes. |
| ⚡ **Slash commands** | `/init` `/review` `/test` `/fix` `/explain` `/commit` `/plan` `/refactor` `/docs` `/scaffold` `/compact` `/model` `/mode` `/clear` |
| 📎 **@-mentions & attachments** | `@src/app.js` pulls a file into context; drag & drop files into the composer. |
| 🧠 **Project memory** | Put instructions in `BUDDO.md` (or run `/init`) — Buddo reads it every session. Also picks up `CLAUDE.md` / `AGENTS.md`. |
| 🎛️ **Command palette** | `⌘/Ctrl + K` for everything: chats, files, modes, models, settings. |
| 🎨 **Polished UI** | Dark & light themes, 5 accent colors, smooth spring animations, responsive layout. |
| 💬 **Chat history** | Searchable, renameable, stored locally. Export anytime. |

## 🚀 Quick start

### 1. Get a free AI engine (pick one)

- **Ollama (recommended):** install from [ollama.com/download](https://ollama.com/download). Buddo can download models for you from its setup screen, or run `ollama pull qwen2.5-coder:7b`.
- **LM Studio / llama.cpp / Jan:** start the local OpenAI-compatible server and choose *LM Studio & others* in Buddo.
- **Nothing to install:** pick *In your browser* — runs small models on your GPU via WebGPU (Chrome / Edge).

### 2. Run Buddo

```bash
git clone https://github.com/arthurknielsen/buddo
cd buddo
npm install
npm start            # opens http://127.0.0.1:4141/app in your browser
```

`npm start` serves the app **and** gives it full access to the folder you started it in (files, terminal, git). To open a different project: `node packages/cli/bin/buddo.js web /path/to/project`, or use **Open folder** inside the app.

### Desktop app

```bash
npm run desktop      # dev run (installs Electron the first time)
cd apps/desktop && npm run dist   # build installers (.dmg / .exe / .AppImage)
```

Pushing a tag like `v1.0.0` builds installers for macOS, Windows and Linux via GitHub Actions and attaches them to a release.

### Terminal CLI

```bash
npm run link                         # installs the `buddo` command globally
buddo                                # interactive session in the current folder
buddo "add input validation to the signup form"
buddo -p "explain src/router.js"     # print mode (scriptable)
buddo models | buddo pull qwen3:8b | buddo doctor
```

Options: `-m <model>`, `--mode ask|auto|yolo|plan`, `--provider ollama|openai`, `--url <engine url>`, `--ctx <tokens>`.

## 🧠 Which model?

Quality depends on the model you run — bigger is smarter but needs more RAM.

| Model | Size | Good for |
|---|---|---|
| `qwen2.5-coder:3b` | 1.9 GB | Low-RAM machines (8 GB) |
| `qwen2.5-coder:7b` | 4.7 GB | **Best all-rounder** (16 GB) |
| `qwen3:8b` | 5.2 GB | Reasoning / thinking mode |
| `qwen2.5-coder:14b` | 9 GB | Noticeably smarter (16–32 GB) |
| `gpt-oss:20b` | 14 GB | Strong open reasoning model |
| `qwen3-coder:30b` | 19 GB | Top-tier local agent (32 GB+) |

Tip: raise the context window in **Settings → Engine** (16k–32k) for bigger projects.

## 🌐 Web vs. local

| | Hosted website / static | `npm start`, CLI or desktop |
|---|---|---|
| Edit files | ✅ via *Open folder* (Chrome/Edge) or the in-browser sandbox | ✅ any folder |
| Run commands / tests / git | ❌ | ✅ |
| Engines | In-browser, or Ollama with `OLLAMA_ORIGINS` set | All |

You can deploy `apps/web/dist` to any static host (GitHub Pages, Netlify, Vercel). The landing page is at `/`, the app at `/app` (configure SPA fallback to `index.html`).

## 🏗️ Project layout

```
packages/core     Agent brain: loop, tool protocol, prompts, providers, diff (shared everywhere)
packages/server   Zero-dependency local server: workspace API, shell, model proxy, static hosting
packages/cli      `buddo` terminal app
apps/web          React + Vite web app and landing page (framer-motion animations)
apps/desktop      Electron wrapper (bundles server + web UI)
```

```bash
npm run dev     # server on :4141 + Vite hot reload on :5173 (open http://localhost:5173/app)
npm test        # core tests (parser, diff, agent loop end-to-end)
npm run build   # build the web app
```

## 🔒 Security

The local server binds to `127.0.0.1` only, requires a custom header on every API call (blocking cross-site requests from other websites), refuses paths outside the open workspace, and only proxies model servers on localhost. In **Ask** mode nothing is written or executed without your approval.

## License

MIT
