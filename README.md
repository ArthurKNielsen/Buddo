# Buddo (from scratch)

A brand-new chat website, built from zero. It doesn't use Ollama, Hugging Face, or transformers. The site, server, chat UI, and markdown renderer are all hand-written. The "brain" is Claude (`claude-opus-5-5`), called through the official Anthropic SDK, so it can actually write Python.

## Features

- Streaming replies in a clean chat UI (light and dark mode)
- Tuned for Python: code comes back in fenced blocks with a **Copy** button
- **20,000-token context limit.** Every request is measured with Claude's token counter. 8,000 tokens are kept free for the reply. When the chat gets too long, the oldest exchanges are dropped and the UI tells you.
- A live token meter in the header
- Chat history is saved in your browser

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # get one at https://console.anthropic.com
npm start
```

Then open http://localhost:3000.

## Settings (env vars)

| Variable | Default | What it does |
|---|---|---|
| `BUDDO_CONTEXT_LIMIT` | `20000` | Total token window (prompt + history + reply) |
| `BUDDO_MAX_OUTPUT` | `8000` | Part of the window kept free for the reply |
| `BUDDO_MODEL` | `claude-opus-5-5` | Which Claude model to use |
| `PORT` | `3000` | Server port |
