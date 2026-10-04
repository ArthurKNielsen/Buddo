#!/usr/bin/env node
// Buddo CLI — a free, local AI coding agent in your terminal.

import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  runAgent, gatherContext, ollamaProvider, openaiCompatProvider, RECOMMENDED_MODELS, SLASH_COMMANDS, parseSlash,
  COMPACT_PROMPT, describeCall, diffLines, diffHunks, diffStats, contextTokens, isTinyModel, thinksNatively, learnAboutUser, VIBES,
} from '@buddo/core';
import { createNodeWorkspace, loadProfile, saveProfile, rememberFact } from '@buddo/core/node';

const VERSION = '1.0.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────────────────────── colors ─────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const rgb = (r, g, b) => (s) => (tty ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : String(s));
const C = {
  bold: c(1), dim: c(2), italic: c(3), under: c(4),
  red: rgb(255, 107, 107), green: rgb(80, 220, 140), yellow: rgb(250, 204, 21), blue: rgb(96, 165, 250),
  violet: rgb(167, 139, 250), cyan: rgb(56, 220, 230), pink: rgb(244, 114, 182), gray: rgb(140, 140, 160),
  bgRed: c('48;2;60;20;24'), bgGreen: c('48;2;16;48;32'),
};

function gradient(text, from = [167, 139, 250], to = [56, 220, 230]) {
  if (!tty) return text;
  const chars = [...text];
  const n = Math.max(1, chars.length - 1);
  return chars
    .map((ch, i) => {
      const t = i / n;
      const [r, g, b] = from.map((f, k) => Math.round(f + (to[k] - f) * t));
      return `\x1b[38;2;${r};${g};${b}m${ch}`;
    })
    .join('') + '\x1b[0m';
}

const LOGO = [
  '██████  ██    ██ ██████  ██████   ██████ ',
  '██   ██ ██    ██ ██   ██ ██   ██ ██    ██',
  '██████  ██    ██ ██   ██ ██   ██ ██    ██',
  '██   ██ ██    ██ ██   ██ ██   ██ ██    ██',
  '██████   ██████  ██████  ██████   ██████ ',
];

// ───────────────────────── config ─────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.buddo');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch {}
}

// ───────────────────────── args ─────────────────────────
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-p' || a === '--print') o.print = true;
    else if (a === '-m' || a === '--model') o.model = next();
    else if (a === '--provider') o.provider = next();
    else if (a === '--url') o.url = next();
    else if (a === '--mode') o.mode = next();
    else if (a === '--yolo') o.mode = 'yolo';
    else if (a === '--plan') o.mode = 'plan';
    else if (a === '--port') o.port = Number(next());
    else if (a === '--no-open') o.noOpen = true;
    else if (a === '-C' || a === '--cwd') o.cwd = next();
    else if (a === '--ctx') o.ctx = Number(next());
    else if (a === '--lite') o.lite = true;
    else if (a === '--think') o.think = true;
    else if (a === '--no-think') o.think = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else o._.push(a);
  }
  return o;
}

const HELP = `
${gradient('buddo')} ${C.dim('v' + VERSION)} — free, local AI coding agent. No API keys.

${C.bold('Usage')}
  buddo                       interactive session in the current folder
  buddo "add a dark mode"     start with a task
  buddo -p "explain this"     run once and print the answer (scriptable)
  buddo web [folder]          open the Buddo web app (localhost)
  buddo models                list installed local models
  buddo pull <model>          download a model via Ollama
  buddo doctor                check your setup

${C.bold('Options')}
  -m, --model <name>          model to use (e.g. qwen2.5-coder:7b)
  --provider ollama|openai    engine (openai = LM Studio / llama.cpp / any local OpenAI-compatible server)
  --url <url>                 engine URL (default http://localhost:11434 or http://localhost:1234/v1)
  --mode ask|auto|yolo|plan   permission mode (default ask)
  --ctx <tokens>              context window (default 16384)
  --lite                      short prompt + small context (auto for tiny models)
  --think / --no-think        ask the model to think out loud (default: on, off for tiny models)
  -C, --cwd <dir>             workspace folder
  --port <n>                  port for \`buddo web\` (default 4141)
`;

// ───────────────────────── main ─────────────────────────
const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig();

if (args.version) {
  console.log(VERSION);
  process.exit(0);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const providerId = args.provider || cfg.provider || 'ollama';
const providerUrl = args.url || cfg.url || (providerId === 'openai' ? 'http://localhost:1234/v1' : 'http://localhost:11434');
const provider = providerId === 'openai' ? openaiCompatProvider({ baseUrl: providerUrl }) : ollamaProvider({ baseUrl: providerUrl });
const cwd = path.resolve(args.cwd || process.cwd());

const sub = args._[0];
if (sub === 'web' || sub === 'serve' || sub === 'app') await cmdWeb();
else if (sub === 'models') await cmdModels();
else if (sub === 'pull') await cmdPull(args._[1]);
else if (sub === 'doctor') await cmdDoctor();
else await cmdChat(args._.join(' '));

// ───────────────────────── subcommands ─────────────────────────
async function cmdWeb() {
  const { startServer } = await import('@buddo/server');
  const candidates = [path.resolve(__dirname, '../../../apps/web/dist'), path.resolve(__dirname, '../web')];
  let webDir = candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
  const repoRoot = path.resolve(__dirname, '../../..');
  if (!webDir && fs.existsSync(path.join(repoRoot, 'apps/web/package.json'))) {
    console.log(C.dim('  Building the web UI (first run only)…'));
    const { execSync } = await import('node:child_process');
    try {
      execSync('npm run build', { cwd: repoRoot, stdio: 'ignore' });
      webDir = candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
    } catch {}
  }
  const root = path.resolve(args._[1] || cwd);
  let srv;
  for (let port = args.port || 4141, tries = 0; tries < 10; port++, tries++) {
    try {
      srv = await startServer({ port, root, webDir, log: (m) => console.log(C.dim(m)) });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  if (!srv) throw new Error('No free port found.');
  console.log('\n' + LOGO.map((l) => '  ' + gradient(l)).join('\n'));
  console.log(`\n  ${C.green('●')} Buddo is running at ${C.bold(C.cyan(srv.url + '/app'))}`);
  console.log(`  ${C.dim('workspace')} ${root}`);
  if (!webDir) console.log(`  ${C.yellow('!')} Web UI not built yet — run ${C.bold('npm run build')} (or use ${C.bold('npm run dev')}).`);
  console.log(C.dim('\n  Press Ctrl+C to stop.\n'));
  if (!args.noOpen) openBrowser(srv.url + '/app');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

async function cmdModels() {
  try {
    const models = await provider.listModels();
    if (!models.length) {
      console.log(`No models installed. Try: ${C.bold('buddo pull qwen2.5-coder:7b')}`);
      return;
    }
    console.log(C.bold('\nInstalled models\n'));
    for (const m of models) console.log(`  ${C.violet('◆')} ${m.id.padEnd(32)} ${C.dim([m.params, m.size ? (m.size / 1e9).toFixed(1) + ' GB' : ''].filter(Boolean).join(' · '))}`);
    console.log();
  } catch (e) {
    engineDown(e);
  }
}

async function cmdPull(model) {
  if (!model) {
    console.log(C.bold('\nRecommended models\n'));
    for (const m of RECOMMENDED_MODELS) console.log(`  ${C.cyan(m.id.padEnd(24))} ${m.size.padEnd(8)} ${C.dim(m.note)}`);
    console.log(`\nRun ${C.bold('buddo pull <model>')}\n`);
    return;
  }
  if (provider.id !== 'ollama') return console.log('Pulling models is only supported with Ollama.');
  try {
    let last = '';
    for await (const p of provider.pull(model)) {
      const pct = p.total ? Math.floor(((p.completed || 0) / p.total) * 100) : null;
      const bar = pct === null ? '' : ' ' + progressBar(pct / 100, 28) + ` ${pct}%`;
      const line = `  ${C.violet('↓')} ${p.status}${bar}`;
      if (line !== last) process.stdout.write('\r\x1b[2K' + line);
      last = line;
    }
    console.log(`\n  ${C.green('✓')} ${model} ready. Start with: ${C.bold(`buddo -m ${model}`)}`);
    cfg.model = model;
    saveConfig(cfg);
  } catch (e) {
    console.log();
    engineDown(e);
  }
}

function progressBar(t, w) {
  const full = Math.round(t * w);
  return gradient('█'.repeat(full)) + C.dim('░'.repeat(w - full));
}

async function cmdDoctor() {
  console.log(C.bold('\nBuddo doctor\n'));
  console.log(`  ${C.green('✓')} Node ${process.version}`);
  try {
    const v = await provider.ping();
    console.log(`  ${C.green('✓')} ${provider.label} reachable at ${providerUrl}${v.version ? ` (v${v.version})` : ''}`);
    const models = await provider.listModels();
    if (models.length) console.log(`  ${C.green('✓')} ${models.length} model(s): ${models.map((m) => m.id).slice(0, 6).join(', ')}`);
    else console.log(`  ${C.yellow('!')} No models yet — run ${C.bold('buddo pull qwen2.5-coder:7b')}`);
  } catch (e) {
    console.log(`  ${C.red('✗')} ${provider.label} not reachable at ${providerUrl}`);
    engineDown(e, true);
  }
  console.log();
}

function engineDown(e, quiet) {
  if (!quiet) console.log(C.red(`\n✗ Can't reach ${provider.label} at ${providerUrl}: ${e.cause?.code || e.message}`));
  if (provider.id === 'ollama') {
    console.log(`
  Buddo runs AI models locally for free with ${C.bold('Ollama')}:
    1. Install: ${C.cyan('https://ollama.com/download')}
    2. Start it (it runs in the background after install, or run ${C.bold('ollama serve')})
    3. ${C.bold('buddo pull qwen2.5-coder:7b')}
`);
  } else console.log(`  Start your local server (e.g. LM Studio → Developer → Start Server).\n`);
}

async function pickModel() {
  const models = await provider.listModels();
  if (args.model) return args.model;
  if (cfg.model && models.some((m) => m.id === cfg.model)) return cfg.model;
  if (!models.length) return null;
  const pref = ['qwen3-coder', 'qwen2.5-coder:14b', 'qwen2.5-coder', 'qwen3', 'gpt-oss', 'deepseek-coder', 'codellama', 'llama3'];
  for (const p of pref) {
    const m = models.find((x) => x.id.startsWith(p) && !/embed/.test(x.id));
    if (m) return m.id;
  }
  return models.find((m) => !/embed/.test(m.id))?.id || models[0].id;
}

// ───────────────────────── chat ─────────────────────────
async function cmdChat(initial) {
  const workspace = createNodeWorkspace(cwd);
  let model;
  try {
    model = await pickModel();
  } catch (e) {
    engineDown(e);
    process.exit(1);
  }
  if (!model) {
    console.log(C.yellow('\nNo local models installed yet.'));
    console.log(`Run ${C.bold('buddo pull qwen2.5-coder:7b')} (≈4.7 GB, one time) and try again.\n`);
    process.exit(1);
  }

  let mode = args.mode || cfg.mode || 'ask';
  let vision = !!(await provider.modelInfo?.(model).catch(() => null))?.vision;
  let profile = loadProfile();
  const isLite = () => !!args.lite || isTinyModel(model);
  const isThinkAloud = () => !thinksNatively(model) && (args.think ?? !isLite());
  const onRemember = (fact) => {
    const ok = rememberFact(fact, 'chat');
    profile = loadProfile();
    return ok;
  };
  const ctxBudget = args.ctx || cfg.ctx || 16384;
  let messages = [];
  let projectCtx = await gatherContext(workspace);

  // Print mode: one shot, no prompts.
  if (args.print) {
    const prompt = initial || fs.readFileSync(0, 'utf8');
    messages.push({ role: 'user', content: prompt });
    let out = '';
    await runAgent({
      provider, model, workspace, messages, mode: args.mode || 'auto', contextBudget: isLite() ? 4096 : ctxBudget, context: projectCtx, vision, profile, lite: isLite(), thinkAloud: isThinkAloud(), callbacks: { onRemember },
      onEvent: (e) => {
        if (e.type === 'text') out += e.delta;
        if (e.type === 'tool-start') out = '';
        if (e.type === 'error') console.error(C.red(e.error));
      },
      askPermission: async () => (args.mode === 'yolo' ? 'allow' : 'deny'),
    });
    console.log(out.trim());
    return;
  }

  // Banner
  console.log('\n' + LOGO.map((l) => '  ' + gradient(l)).join('\n'));
  console.log(
    `\n  ${C.dim('model')} ${C.cyan(model)}${vision ? C.dim(' 👁') : ''}  ${C.dim('mode')} ${modeLabel(mode)}  ${C.dim('folder')} ${C.bold(workspace.name)}${projectCtx.memory ? C.dim('  · BUDDO.md loaded') : ''}`,
  );
  console.log(C.dim(`  /help for commands · Ctrl+C to stop a response · /exit to quit\n`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 200 });
  let running = null;
  let lastCtrlC = 0;

  rl.on('SIGINT', () => {
    if (running) {
      running.abort();
      return;
    }
    const now = Date.now();
    if (now - lastCtrlC < 1500) process.exit(0);
    lastCtrlC = now;
    console.log(C.dim('\n(press Ctrl+C again to exit)'));
    rl.prompt();
  });

  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  async function turn(input) {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (trimmed === '/exit' || trimmed === '/quit') process.exit(0);

    let prompt = trimmed;
    let runMode = mode;
    const slash = parseSlash(trimmed);
    if (slash?.unknown) {
      console.log(C.red(`Unknown command /${slash.unknown}. Try /help.`));
      return;
    }
    if (slash) {
      const { cmd, arg } = slash;
      if (cmd.action === 'help') return printHelp();
      if (cmd.action === 'clear') {
        messages = [];
        projectCtx = await gatherContext(workspace);
        console.clear();
        console.log(C.dim('✓ New conversation.\n'));
        return;
      }
      if (cmd.action === 'mode') {
        if (['ask', 'auto', 'yolo', 'plan'].includes(arg)) mode = arg;
        else mode = { ask: 'auto', auto: 'yolo', yolo: 'plan', plan: 'ask' }[mode];
        console.log(`Mode → ${modeLabel(mode)}`);
        return;
      }
      if (cmd.action === 'model') {
        const models = await provider.listModels().catch(() => []);
        if (arg) {
          model = arg;
          cfg.model = arg;
          saveConfig(cfg);
          vision = !!(await provider.modelInfo?.(model).catch(() => null))?.vision;
          console.log(`Model → ${C.cyan(model)}`);
          return;
        }
        models.forEach((m, i) => console.log(`  ${C.dim(String(i + 1).padStart(2))}  ${m.id === model ? C.cyan('● ' + m.id) : '  ' + m.id}`));
        const pick = await ask(C.dim('  number › '));
        const m = models[Number(pick) - 1];
        if (m) {
          model = m.id;
          cfg.model = model;
          saveConfig(cfg);
          vision = !!(await provider.modelInfo?.(model).catch(() => null))?.vision;
          console.log(`Model → ${C.cyan(model)}`);
        }
        return;
      }
      if (cmd.action === 'memory') {
        profile = loadProfile();
        console.log(C.bold(`\n${profile.name} knows ${profile.memories.length} thing(s) about you`) + C.dim(`  (vibe: ${profile.vibe}, learning ${profile.learn ? 'on' : 'off'})`));
        profile.memories.forEach((m, i) => console.log(`  ${C.dim(String(i + 1).padStart(2))}  ${m.text}`));
        console.log(C.dim('\n  Forget one with /memory forget <number>, everything with /memory clear, toggle with /memory off|on\n'));
        if (/^forget\s+\d+/.test(arg)) {
          const n = Number(arg.split(/\s+/)[1]) - 1;
          if (profile.memories[n]) saveProfile({ ...profile, memories: profile.memories.filter((_, i) => i !== n) });
          console.log(C.green('✓ forgotten'));
        } else if (arg === 'clear') {
          saveProfile({ ...profile, memories: [] });
          console.log(C.green('✓ memory cleared'));
        } else if (arg === 'off' || arg === 'on') {
          saveProfile({ ...profile, learn: arg === 'on' });
          console.log(C.green(`✓ learning ${arg}`));
        }
        profile = loadProfile();
        return;
      }
      if (cmd.action === 'vibe') {
        if (VIBES[arg]) {
          saveProfile({ ...loadProfile(), vibe: arg });
          profile = loadProfile();
          console.log(`Vibe → ${C.violet(VIBES[arg].emoji + ' ' + VIBES[arg].label)}`);
        } else console.log(Object.entries(VIBES).map(([k, v]) => `  ${C.violet(k.padEnd(8))} ${v.emoji} ${v.label}`).join('\n'));
        return;
      }
      if (cmd.action === 'compact') {
        if (!messages.length) return console.log(C.dim('Nothing to compact.'));
        prompt = COMPACT_PROMPT;
        await runTurn(prompt, 'plan', true);
        const summary = messages[messages.length - 1]?.content || '';
        messages = [{ role: 'user', content: 'Context from earlier in this session:\n' + summary }, { role: 'assistant', content: 'Got it — I have the context.' }];
        console.log(C.dim(`\n✓ Compacted to ~${contextTokens(messages)} tokens.\n`));
        return;
      }
      if (cmd.prompt) {
        if (cmd.arg && !arg && ['plan', 'fix', 'scaffold', 'watch'].includes(cmd.name)) {
          console.log(C.dim(`Usage: /${cmd.name} <${cmd.arg}>`));
          return;
        }
        prompt = cmd.prompt(arg);
        if (cmd.mode) runMode = cmd.mode;
      }
    }
    // @file mentions → inline the file content.
    prompt = await expandMentions(prompt, workspace);
    await runTurn(prompt, runMode);
  }

  async function runTurn(prompt, runMode, quiet = false) {
    messages.push({ role: 'user', content: prompt });
    const ctrl = new AbortController();
    running = ctrl;
    const r = renderer();
    const started = Date.now();
    let usage;
    await runAgent({
      provider, model, workspace, messages, mode: runMode, signal: ctrl.signal, contextBudget: isLite() ? 4096 : ctxBudget, context: projectCtx, vision, profile, lite: isLite(), thinkAloud: isThinkAloud(),
      onEvent: (e) => {
        if (e.type === 'usage') usage = e;
        r.event(e, quiet);
      },
      askPermission: async (call) => {
        r.pauseSpinner();
        const label = call.name === 'run_command' ? `run ${C.bold(call.args.command)}` : `${call.name === 'write_file' ? 'write' : 'edit'} ${C.bold(call.args.path)}`;
        if (call.name !== 'run_command') printDiffPreview(call, workspace);
        const ans = (await ask(`  ${C.yellow('?')} Allow Buddo to ${label}? ${C.dim('[y]es / [n]o / [a]lways')} › `)).trim().toLowerCase();
        return ans.startsWith('a') ? 'always' : ans === '' || ans.startsWith('y') ? 'allow' : 'deny';
      },
      callbacks: { onRemember: (f) => { const ok = onRemember(f); if (ok) r.note(`🧠 Remembered: ${f}`); return ok; } },
    });
    r.end();
    // Quietly learn about the user from what they said (skipped for tiny models).
    if (!quiet && profile.learn && !isLite() && !ctrl.signal.aborted) {
      learnAboutUser({ provider, model, profile, userTexts: [prompt.split('\n\n<file')[0]], contextBudget: isLite() ? 4096 : ctxBudget })
        .then((facts) => facts.filter((f) => rememberFact(f, 'auto')))
        .then((added) => { profile = loadProfile(); if (added.length) console.log(C.dim(`  🧠 learned: ${added.join(' · ')}`)); })
        .catch(() => {});
    }
    running = null;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const tps = usage?.tps ? ` · ${usage.tps.toFixed(0)} tok/s` : '';
    console.log(C.dim(`\n  ${secs}s${tps} · context ~${contextTokens(messages).toLocaleString()}/${ctxBudget.toLocaleString()} tokens\n`));
  }

  function printHelp() {
    console.log(C.bold('\nCommands'));
    for (const cmd of SLASH_COMMANDS) console.log(`  ${C.violet(('/' + cmd.name + (cmd.arg ? ` <${cmd.arg}>` : '')).padEnd(24))} ${C.dim(cmd.desc)}`);
    console.log(`  ${C.violet('/exit'.padEnd(24))} ${C.dim('Quit')}`);
    console.log(C.bold('\nTips'));
    console.log(C.dim('  Mention files with @path/to/file to include them.'));
    console.log(C.dim('  Modes: ask (confirm edits+commands) · auto (auto-edit) · yolo (no prompts) · plan (read-only)\n'));
  }

  const loop = async (first) => {
    if (first) await turn(first);
    rl.setPrompt(gradient('› '));
    rl.prompt();
    let busy = false;
    rl.on('line', async (line) => {
      if (busy) return;
      busy = true;
      rl.pause();
      try {
        await turn(line);
      } catch (e) {
        console.log(C.red(String(e?.message || e)));
      }
      busy = false;
      rl.resume();
      rl.prompt();
    });
  };
  await loop(initial);
}

function modeLabel(m) {
  return { ask: C.blue('ask'), auto: C.green('auto-edit'), yolo: C.red('yolo'), plan: C.yellow('plan') }[m] || m;
}

async function expandMentions(prompt, workspace) {
  const mentions = [...prompt.matchAll(/(?:^|\s)@([\w./-]+\.[\w]+)/g)].map((m) => m[1]);
  if (!mentions.length) return prompt;
  let extra = '';
  for (const f of [...new Set(mentions)].slice(0, 8)) {
    try {
      const content = await workspace.read(f);
      extra += `\n\n<file path="${f}">\n${content.slice(0, 30000)}\n</file>`;
    } catch {}
  }
  return prompt + extra;
}

function printDiffPreview(call, workspace) {
  try {
    let before = '';
    try {
      before = fs.readFileSync(path.join(workspace.root, call.args.path), 'utf8');
    } catch {}
    let after = call.args.content ?? '';
    if (call.name === 'edit_file') after = before.includes(call.args.old) ? before.replace(call.args.old, call.args.new ?? '') : before;
    printDiff(before, after, 30);
  } catch {}
}

function printDiff(before, after, max = 24) {
  const d = diffLines(before || '', after || '');
  const h = diffHunks(d, 2);
  let n = 0;
  for (const l of h) {
    if (n++ >= max) {
      console.log(C.dim(`      … ${h.length - max} more lines`));
      break;
    }
    if (l.type === 'skip') console.log(C.dim(`      ⋯ ${l.count} unchanged`));
    else if (l.type === '+') console.log(C.bgGreen(C.green(`  ${String(l.b).padStart(4)} + ${l.text}`)));
    else if (l.type === '-') console.log(C.bgRed(C.red(`  ${String(l.a).padStart(4)} - ${l.text}`)));
    else console.log(C.dim(`  ${String(l.b).padStart(4)}   ${l.text}`));
  }
}

// Streams model output with light markdown styling, spinners and tool cards.
function renderer() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const verbs = ['Thinking', 'Pondering', 'Cooking', 'Brewing', 'Scheming', 'Vibing', 'Crafting'];
  const verb = verbs[Math.floor(Math.random() * verbs.length)];
  let spin = null;
  let f = 0;
  let line = '';
  let inFence = false;
  let label = verb;
  const t0 = Date.now();
  let thinkingChars = 0;
  // Live code: print each finished line while the model is still writing the file.
  let live = null; // { key, printed }
  let streamedCall = false;

  const startSpinner = (text = verb) => {
    label = text;
    if (spin || !tty) return;
    spin = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      process.stdout.write(`\r\x1b[2K  ${C.violet(frames[f++ % frames.length])} ${gradient(label + '…')} ${C.dim(`${s}s${thinkingChars ? ` · thought ${thinkingChars} chars` : ''} · ctrl+c to stop`)}`);
    }, 80);
  };
  const stopSpinner = () => {
    if (spin) {
      clearInterval(spin);
      spin = null;
      process.stdout.write('\r\x1b[2K');
    }
  };

  const fmt = (l) => {
    if (/^\s*```/.test(l)) {
      inFence = !inFence;
      return C.dim(l);
    }
    if (inFence) return C.cyan('  ' + l);
    if (/^#{1,6}\s/.test(l)) return C.bold(C.violet(l.replace(/^#+\s/, '')));
    return l
      .replace(/\*\*([^*]+)\*\*/g, (_, s) => C.bold(s))
      .replace(/`([^`]+)`/g, (_, s) => C.cyan(s))
      .replace(/^(\s*)[-*] /, (_, s) => s + C.violet('• '));
  };

  // Thoughts stream in dim italics under a "✻ Thinking" header.
  let thought = null; // text of the current line
  const writeThought = (delta) => {
    stopSpinner();
    if (thought === null) {
      flush();
      process.stdout.write(`\n${C.dim('✻ Thinking')}\n  `);
      thought = '';
      delta = delta.replace(/^\s+/, '');
    }
    delta.split('\n').forEach((part, i) => {
      if (i > 0) {
        if (thought) process.stdout.write('\n  ');
        thought = '';
      }
      if (part) process.stdout.write(C.dim(C.italic(part)));
      thought += part;
    });
  };
  const endThought = () => {
    if (thought === null) return;
    process.stdout.write('\n');
    thought = null;
  };

  let started = false;
  const writeText = (delta) => {
    if (!started && !line) delta = delta.replace(/^\s+/, ""); // no empty bullets for stray newlines
    if (!delta) return;
    stopSpinner();
    if (!started) {
      process.stdout.write('\n' + C.violet('⏺ '));
      started = true;
    }
    line += delta;
    let nl;
    while ((nl = line.indexOf('\n')) !== -1) {
      process.stdout.write(fmt(line.slice(0, nl)) + '\n  ');
      line = line.slice(nl + 1);
    }
  };
  const flush = () => {
    if (line) process.stdout.write(fmt(line));
    line = '';
    if (started) process.stdout.write('\n');
    started = false;
  };

  startSpinner();
  const toolNames = { list_dir: 'List', read_file: 'Read', search: 'Search', glob: 'Glob', write_file: 'Write', edit_file: 'Update', run_command: 'Bash', fetch_url: 'Fetch', todo: 'Todos', watch_video: 'Watch', listen_audio: 'Listen', view_image: 'Look', web_search: 'Search', screenshot: 'Screenshot', record_video: 'Record', make_video: 'Make video', edit_video: 'Edit video', remember: 'Remember' };

  return {
    note(text) {
      stopSpinner();
      console.log(`  ${C.violet(text)}`);
    },
    pauseSpinner: stopSpinner,
    event(e, quiet) {
      switch (e.type) {
        case 'step': {
          endThought();
          const k = e.promptTokens >= 1000 ? `${(e.promptTokens / 1000).toFixed(1)}k` : e.promptTokens;
          startSpinner(`${e.after ? `Reading the ${e.after} result` : 'Reading your message'} (${k} tokens)`);
          break;
        }
        case 'raw':
          // First token: the model has finished reading (just relabel; never draw over streamed thoughts).
          if (label.startsWith('Reading')) label = 'Writing';
          break;
        case 'thinking':
          thinkingChars += e.delta.length;
          if (quiet) startSpinner('Thinking');
          else writeThought(e.delta);
          break;
        case 'text':
          endThought();
          if (!quiet) writeText(e.delta);
          break;
        case 'tool-preparing':
          endThought();
          flush();
          startSpinner(e.name === 'write_file' || e.name === 'edit_file' ? 'Writing code' : 'Working');
          break;
        case 'tool-stream': {
          const code = e.name === 'write_file' ? e.args.content : e.name === 'edit_file' ? e.args.new : null;
          if (code === undefined || code === null || quiet) break;
          const key = `${e.name}:${e.args.path}:${e.name === 'edit_file' && e.writing !== 'new' ? 'old' : 'new'}`;
          if (live?.key !== key) {
            if (e.name === 'edit_file' && e.writing !== 'new') break; // only show the new code for edits
            stopSpinner();
            console.log(`\n${C.violet('✎')} ${C.bold(e.name === 'write_file' ? 'Writing' : 'Editing')} ${e.args.path || ''} ${C.dim('(live)')}`);
            live = { key, printed: 0 };
          }
          const lines = code.split('\n');
          // Only print lines that are complete (the last one may still be growing).
          for (; live.printed < lines.length - 1; live.printed++) {
            stopSpinner();
            console.log(`  ${C.dim(String(live.printed + 1).padStart(4) + ' │')} ${C.gray(lines[live.printed].slice(0, 160))}`);
          }
          startSpinner('Writing code');
          break;
        }
        case 'tool-start': {
          flush();
          stopSpinner();
          // Auto-saved code blocks were already printed as text.
          streamedCall = e.call.auto || (!!live && (e.call.name === 'write_file' || e.call.name === 'edit_file'));
          if (live) {
            const code = e.call.name === 'write_file' ? e.call.args.content : e.call.args.new;
            const lines = (code || '').split('\n');
            for (; live.printed < lines.length; live.printed++) console.log(`  ${C.dim(String(live.printed + 1).padStart(4) + ' │')} ${C.gray(lines[live.printed].slice(0, 160))}`);
            live = null;
          }
          const name = toolNames[e.call.name] || e.call.name;
          console.log(`\n${C.green('⏺')} ${C.bold(name)}${C.dim('(')}${describeCall(e.call)}${C.dim(')')}${e.call.quick ? C.dim(' · done by Buddo') : e.call.auto ? C.dim(' · from code block') : ''}`);
          break;
        }
        case 'nudge':
          flush();
          stopSpinner();
          console.log(C.dim(`\n  ℹ ${e.text}`));
          break;
        case 'tool-end': {
          stopSpinner();
          const d = e.display;
          if (!e.ok) console.log(`  ${C.dim('⎿')} ${e.denied ? C.yellow('Denied') : C.red(e.output.split('\n')[0].slice(0, 160))}`);
          else if (d?.type === 'diff') {
            const s = diffStats(diffLines(d.before || '', d.after));
            console.log(`  ${C.dim('⎿')} ${d.created ? 'Created' : 'Updated'} ${C.bold(d.path)} with ${C.green('+' + s.added)} ${C.red('-' + s.removed)}`);
            // New files were already shown line by line while they were being written.
            if (!(streamedCall && d.created)) printDiff(d.before || '', d.after, 14);
          } else if (d?.type === 'terminal') {
            const lines = (d.output || '').trimEnd().split('\n').filter(Boolean);
            lines.slice(-8).forEach((l, i) => console.log(`  ${C.dim(i === 0 ? '⎿' : ' ')}  ${C.gray(l.slice(0, 200))}`));
            console.log(`     ${d.code === 0 ? C.green('✓ exit 0') : C.red('✗ exit ' + d.code)}`);
          } else if (d?.type === 'todos') {
            d.todos.forEach((t, i) =>
              console.log(`  ${C.dim(i === 0 ? '⎿' : ' ')} ${t.status === 'done' ? C.green('☒ ' + C.dim(t.text)) : t.status === 'active' ? C.yellow('◐ ' + C.bold(t.text)) : '☐ ' + t.text}`),
            );
          } else if (d?.type === 'websearch') {
            console.log(`  ${C.dim('⎿')} ${d.results.length} results${d.engine ? C.dim(` via ${d.engine}`) : ''}`);
            d.results.slice(0, 5).forEach((x) => console.log(`     ${C.cyan(x.title.slice(0, 70))} ${C.dim(x.url.slice(0, 60))}`));
          } else if (d?.type === 'memory') {
            console.log(`  ${C.dim('⎿')} 🧠 ${d.fact}`);
          } else if (d?.type === 'media' && (d.kind === 'screenshot' || d.kind === 'recording')) {
            const r = d.report || {};
            const issues = [r.overflowX && `overflow ${r.overflowX}px`, r.brokenImages?.length && `${r.brokenImages.length} broken image(s)`, d.logs?.some((l) => l.type === 'error') && 'console errors'].filter(Boolean);
            console.log(`  ${C.dim('⎿')} ${d.kind === 'screenshot' ? `Screenshot ${d.size.join('×')}` : `Recorded ${d.saved}`} in ${C.green((d.ms / 1000).toFixed(1) + 's')} · ${issues.length ? C.yellow('⚠ ' + issues.join(', ')) : C.green('✓ no issues')}`);
            (d.steps || []).slice(0, 6).forEach((s) => console.log(`     ${C.gray(s)}`));
          } else if (d?.type === 'media' && d.kind === 'made') {
            console.log(`  ${C.dim('⎿')} 🎬 Saved ${C.bold(d.saved)}${d.meta?.duration ? ` · ${d.meta.duration.toFixed(1)}s ${d.meta.width}×${d.meta.height}` : ''} in ${C.green((d.ms / 1000).toFixed(1) + 's')}`);
          } else if (d?.type === 'media') {
            const secs = C.green(`${(d.ms / 1000).toFixed(1)}s`);
            if (d.kind === 'video') {
              console.log(`  ${C.dim('⎿')} Watched ${C.bold(d.frames.length)} frames in ${secs}${d.cuts.length ? C.dim(` · cuts at ${d.cuts.map((t) => t.toFixed(1) + 's').join(', ')}`) : ''}`);
              d.frames.slice(0, 8).forEach((f) => console.log(`     ${C.violet(f.t.toFixed(1).padStart(5) + 's')} ${C.gray(f.objects)}`));
            } else if (d.kind === 'image') console.log(`  ${C.dim('⎿')} Looked in ${secs}: ${d.objects.map((o) => o.label).join(', ') || 'no common objects'}`);
            else console.log(`  ${C.dim('⎿')} Listened in ${secs}`);
            const h = d.hearing;
            if (h?.speech?.segments.length) h.speech.segments.slice(0, 6).forEach((s) => console.log(`     ${C.cyan(s.start.toFixed(1).padStart(5) + 's')} ${C.gray('“' + s.text + '”')}`));
            if (h?.sounds?.overall.length) console.log(`     ${C.dim('sounds:')} ${h.sounds.overall.slice(0, 5).map((s) => `${s.label} ${Math.round(s.prob * 100)}%`).join(', ')}`);
          } else if (d?.type === 'file') console.log(`  ${C.dim('⎿')} Read ${C.bold(d.end - d.start + 1)} lines`);
          else if (d?.type === 'search') console.log(`  ${C.dim('⎿')} Found ${C.bold(d.hits.length)} matches`);
          else if (d?.type === 'files') console.log(`  ${C.dim('⎿')} Found ${C.bold(d.files.length)} files`);
          else console.log(`  ${C.dim('⎿')} ${C.dim(e.output.split('\n')[0].slice(0, 120))}`);
          startSpinner(verb);
          break;
        }
        case 'error':
          flush();
          stopSpinner();
          console.log(C.red(`\n✗ ${e.error}`));
          break;
        case 'stopped':
          flush();
          stopSpinner();
          console.log(C.yellow('\n■ Stopped.'));
          break;
        case 'done':
          flush();
          stopSpinner();
          break;
      }
    },
    end() {
      flush();
      stopSpinner();
    },
  };
}
