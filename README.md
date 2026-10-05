# Buddo (from scratch)

A brand-new chat website, built from zero. It doesn't use Ollama, Hugging Face, or transformers. The site, server, chat UI, and markdown renderer are all hand-written. The "brain" is Claude (`claude-opus-5-5`), called through the official Anthropic SDK, so it can actually write Python.

## Features

- Streaming replies in a clean chat UI (light and dark mode)
- Tuned for Python: code comes back in fenced blocks with a **Copy** button
- **20,000-token context limit.** Every request is measured with Claude's token counter. 8,000 tokens are kept free for the reply. When the chat gets too long, the oldest exchanges are dropped and the UI tells you.
- A live token meter in the header
- Chat history is saved in your browser
- **Phone-ready:** mobile layout, notch/safe-area support, and Add to Home Screen so it opens like an app
- Optional password (`BUDDO_PASSWORD`) so nobody else can spend your API credits

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # get one at https://console.anthropic.com
npm start
```

Then open http://localhost:3000.

## Use it on your phone

**Option A: same Wi-Fi (quickest).** Run `npm start` on your computer. It prints an `On your phone` link like `http://192.168.1.20:3000`. Open that link on your phone. It only works while your computer is on.

**Option B: host it online (works anywhere).**
1. Make an account at [render.com](https://render.com) (the free plan works).
2. Click **New → Blueprint** and pick this repo. It reads `render.yaml` and deploys the `buddo-from-scratch` branch.
3. When it asks, paste your `ANTHROPIC_API_KEY` and choose a `BUDDO_PASSWORD`.
4. Open your `https://buddo-xxxx.onrender.com` link on your phone and enter the password.

On the free plan, the server falls asleep after about 15 minutes with no use, so the first message after that can take up to a minute.

**Add to Home Screen:** in Safari tap Share → *Add to Home Screen*. In Chrome tap ⋮ → *Add to Home screen*. Buddo then opens full-screen like an app.

## Settings (env vars)

| Variable | Default | What it does |
|---|---|---|
| `BUDDO_CONTEXT_LIMIT` | `20000` | Total token window (prompt + history + reply) |
| `BUDDO_MAX_OUTPUT` | `8000` | Part of the window kept free for the reply |
| `BUDDO_MODEL` | `claude-opus-5-5` | Which Claude model to use |
| `BUDDO_PASSWORD` | *(none)* | Password needed to chat. Set this whenever the site is public |
| `PORT` | `3000` | Server port |
