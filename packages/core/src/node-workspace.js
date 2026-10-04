// Real filesystem + shell workspace (used by the server, desktop app and CLI).

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { IGNORED_DIRS, matchGlob, searchFiles, htmlToText, isTextLike } from './tree.js';
import { webSearch } from './websearch.js';

const MAX_FILES = 20000;

// Senses (video / audio / image) live in the optional @buddo/media package.
let mediaLib;
export async function loadMedia() {
  if (!mediaLib) {
    mediaLib = import('@buddo/media').catch((e) => {
      mediaLib = null;
      throw new Error(`Media support isn't installed (${e.message}). Run \`npm install\` in the Buddo folder.`);
    });
  }
  return mediaLib;
}

export function createNodeWorkspace(rootDir, { browserProvider, searxng = process.env.BUDDO_SEARXNG } = {}) {
  const root = path.resolve(rootDir);

  const abs = (p = '.') => {
    const r = path.resolve(root, String(p).replace(/^\/+/, ''));
    if (r !== root && !r.startsWith(root + path.sep)) throw new Error(`Path "${p}" is outside the workspace.`);
    return r;
  };
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');

  async function walk(start = '.', maxDepth = Infinity) {
    const out = [];
    const base = abs(start);
    async function go(dir, depth) {
      if (out.length >= MAX_FILES) return;
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const it of items) {
        if (it.name === '.DS_Store') continue;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          if (IGNORED_DIRS.has(it.name)) continue;
          out.push({ path: rel(full), type: 'dir' });
          if (depth + 1 < maxDepth) await go(full, depth + 1);
        } else if (it.isFile() || it.isSymbolicLink()) {
          out.push({ path: rel(full), type: 'file' });
        }
      }
    }
    await go(base, 0);
    return out;
  }

  const files = async (start = '.') => (await walk(start)).filter((e) => e.type === 'file').map((e) => e.path);

  return {
    kind: 'local folder',
    name: path.basename(root) || root,
    root,
    capabilities: { exec: true, fetch: true },
    list: (p = '.', depth = 2) => walk(p, depth),
    async read(p) {
      const full = abs(p);
      const st = await fs.stat(full).catch(() => null);
      if (!st) throw new Error(`File not found: ${p}`);
      if (st.isDirectory()) throw new Error(`${p} is a directory — use list_dir.`);
      if (!isTextLike(p)) throw new Error(`${p} is a binary file. For media use watch_video, listen_audio or view_image.`);
      if (st.size > 5_000_000) throw new Error(`${p} is too large to read (${(st.size / 1e6).toFixed(1)} MB).`);
      return fs.readFile(full, 'utf8');
    },
    async write(p, content) {
      const full = abs(p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, 'utf8');
    },
    async writeBinary(p, bytes) {
      const full = abs(p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, bytes);
    },
    async remove(p) {
      await fs.rm(abs(p), { force: true });
    },
    async search(pattern, { path: p = '.', glob, limit } = {}) {
      return searchFiles({ files: await files(p), read: (f) => fs.readFile(abs(f), 'utf8'), pattern, glob, limit });
    },
    async glob(pattern) {
      return matchGlob(await files('.'), pattern);
    },
    run(command, { cwd, timeout = 120000, onData } = {}) {
      return new Promise((resolve) => {
        const child = spawn(command, {
          cwd: abs(cwd || '.'),
          shell: true,
          env: { ...process.env, CI: '1', FORCE_COLOR: '0', GIT_PAGER: 'cat', PAGER: 'cat' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const cap = (s) => (s.length > 400_000 ? s.slice(-400_000) : s);
        child.stdout.on('data', (d) => {
          stdout = cap(stdout + d);
          onData?.(String(d));
        });
        child.stderr.on('data', (d) => {
          stderr = cap(stderr + d);
          onData?.(String(d));
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeout);
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve({ code: 127, stdout, stderr: stderr + String(e.message), timedOut });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, stdout, stderr, timedOut });
        });
      });
    },
    media: {
      watch_video: async ({ path: p, ...o }) => (await loadMedia()).watchVideo(abs(p), o),
      listen_audio: async ({ path: p, ...o }) => (await loadMedia()).listenAudio(abs(p), o),
      view_image: async ({ path: p }) => (await loadMedia()).viewImage(abs(p)),
      screenshot: async (o) => (await loadMedia()).screenshot({ ...o, root, provider: browserProvider }),
      record_video: async (o) => (await loadMedia()).recordVideo({ ...o, root, provider: browserProvider }),
      make_video: async (o) => (await loadMedia()).makeVideo({ ...o, root, provider: browserProvider }),
      edit_video: async (o) => (await loadMedia()).editVideo({ ...o, root, provider: browserProvider }),
    },
    webSearch: (q, o = {}) => webSearch(q, { searxng, ...o }),
    async fetchUrl(url) {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported.');
      const r = await fetch(url, { headers: { 'user-agent': 'Buddo/1.0 (+local agent)' }, signal: AbortSignal.timeout(20000) });
      const type = r.headers.get('content-type') || '';
      const body = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
      return type.includes('html') ? htmlToText(body) : body;
    },
  };
}

export { loadProfile, saveProfile, rememberFact, PROFILE_FILE } from './profile-store.js';
