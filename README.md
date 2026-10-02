<div align="center">

<img src="apps/desktop/icon.png" width="96" alt="Buddo logo" />

# Buddo

**A free, local-first AI coding agent. No API keys. No subscriptions. Your code never leaves your machine.**

Web app · Desktop app · Terminal CLI

**[🌐 Try Buddo in your browser](https://arthurknielsen.github.io/Buddo/app)** — works on iPhone too: open it in Safari, then tap **Share → Add to Home Screen**.

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
| 👁️👂 **Watches, hears & sees** | `watch_video`, `listen_audio`, `view_image`: key frames + scene cuts + objects, speech-to-text with timestamps (99 languages), sound recognition and loudness — about a second per clip, fully local. Vision models (e.g. `qwen2.5vl:7b`) see the frames; other models get text descriptions. Paste or drop images into the chat. |
| 📸 **Sees its own work** | `screenshot` and `record_video`: Buddo opens what it built (desktop + phone sizes), clicks/types through it, and gets a report of console errors, broken images and layout overflow — then fixes what it finds. Uses the desktop app's built-in browser, or your Chrome/Edge. |
| 🔎 **Web search** | `web_search`, free with no API key: DuckDuckGo → Mojeek → Wikipedia fallback (or your own SearxNG via `BUDDO_SEARXNG`), plus npm package search. |
| 😎 **Personality that learns you** | Pick a vibe (Friendly, Gen Z, Professional, Hype coach, Teacher, Minimal), name, reply length and emoji. Buddo remembers lasting facts about you (`remember` tool + quiet learning after chats). See, add or delete memories in **Settings → Personality**, `/memory`, `/vibe`. Shared between app, desktop and CLI (`~/.buddo/profile.json`). |
| ⚡ **Pocket mode (iPhone)** | Tiny in-browser models (0.5B–1B, ~200–700 MB) plus a ~9× shorter "lite" prompt and small context, so it's usable on phones. Auto-selected on mobile. |
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

## 👁️👂 Senses (video, audio, images)

In the desktop app, `npm start` or the CLI, Buddo can perceive media files in your project:

| Tool | What it gives the model | Speed (11 s phone video, 4-core laptop CPU) |
|---|---|---|
| `watch_video` | scene cuts, 12 key frames as one contact-sheet image, objects per frame, transcript, sounds, loudness | ~1.5 s |
| `listen_audio` | timestamped transcript (Whisper, 99 languages), sounds over time (527 AudioSet classes), loudness & silences | ~1 s per 7 s of speech |
| `view_image` | the picture (for vision models) + detected objects with positions | ~0.3 s |

The models are small, free and fetched once from GitHub (~210 MB download, ~80 MB on disk) — **Settings → Senses → Download**, or automatically on first use. ffmpeg is bundled. For the model to *see* the frames, pick a vision model such as `qwen2.5vl:7b` or `gemma3:4b`.

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
| `qwen2.5vl:7b` 👁 | 6 GB | Sees images & video frames |
| `gemma3:4b` 👁 | 3.3 GB | Small vision model |

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
packages/media    Senses: ffmpeg, Whisper + Silero VAD + AudioSet (sherpa-onnx), YOLO11 (onnxruntime)
packages/server   Local server: workspace API, shell, model proxy, static hosting
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
