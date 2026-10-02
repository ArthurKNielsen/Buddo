// Workspaces the agent can operate on from the web UI:
//  - server:  your real folder via the local Buddo server (files + shell)
//  - folder:  a real folder opened in the browser via the File System Access API (files only)
//  - sandbox: an in-browser virtual project stored in localStorage (files only)

import { IGNORED_DIRS, matchGlob, searchFiles, htmlToText, webSearch } from '@buddo/core';

// Browsers can't reach most search engines (CORS), so pure-browser mode searches Wikipedia or npm.
const browserSearch = (q, o = {}) => webSearch(q, { ...o, engines: ['wikipedia'] });

const H = { 'x-buddo': '1' };

export async function api(path, { method = 'GET', body, signal } = {}) {
  const r = await fetch(path, {
    method,
    headers: body ? { ...H, 'content-type': 'application/json' } : H,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = { error: text };
  }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function detectServer() {
  try {
    const r = await fetch('/api/health', { headers: H, signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const j = await r.json();
    return j.app === 'buddo' ? j : false;
  } catch {
    return false;
  }
}

function filterDepth(entries, base, depth) {
  const b = base === '.' || !base ? '' : base.replace(/\/$/, '') + '/';
  return entries.filter((e) => {
    if (b && !e.path.startsWith(b)) return false;
    return e.path.slice(b.length).split('/').length <= depth;
  });
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  return (r.headers.get('content-type') || '').includes('html') ? htmlToText(t) : t;
}

export function serverWorkspace(info) {
  return {
    kind: 'local folder',
    type: 'server',
    name: info.name,
    root: info.root,
    capabilities: { exec: true, fetch: true },
    list: async (path = '.', depth = 2) => (await api(`/api/fs/list?path=${encodeURIComponent(path)}&depth=${depth}`)).entries,
    read: async (path) => (await api(`/api/fs/read?path=${encodeURIComponent(path)}`)).content,
    write: (path, content) => api('/api/fs/write', { method: 'POST', body: { path, content } }),
    remove: (path) => api('/api/fs/remove', { method: 'POST', body: { path } }),
    search: async (pattern, opts = {}) => (await api('/api/fs/search', { method: 'POST', body: { pattern, ...opts } })).hits,
    glob: async (pattern) => (await api('/api/fs/glob', { method: 'POST', body: { pattern } })).files,
    fetchUrl: async (url) => (await api('/api/fetch', { method: 'POST', body: { url } })).text,
    media: {
      watch_video: (args) => api('/api/media/watch_video', { method: 'POST', body: args }),
      listen_audio: (args) => api('/api/media/listen_audio', { method: 'POST', body: args }),
      view_image: (args) => api('/api/media/view_image', { method: 'POST', body: args }),
      screenshot: (args) => api('/api/media/screenshot', { method: 'POST', body: args }),
      record_video: (args) => api('/api/media/record_video', { method: 'POST', body: args }),
    },
    webSearch: (query, o = {}) => api('/api/websearch', { method: 'POST', body: { query, ...o } }),
    rawUrl: (path) => `/api/fs/raw?path=${encodeURIComponent(path)}&token=${info.rawToken}`,
    async run(command, { cwd, timeout, onData, signal } = {}) {
      const r = await fetch('/api/exec', {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ command, cwd, timeout }),
        signal,
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let result = { code: 1, stdout: '', stderr: '' };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const j = JSON.parse(line);
          if (j.type === 'data') onData?.(j.text);
          else if (j.type === 'exit') result = j;
        }
      }
      return result;
    },
  };
}

// ── Browser folder (File System Access API) ──
export const supportsFolderAccess = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export function browserFolderWorkspace(dir) {
  async function walk(maxDepth = Infinity) {
    const out = [];
    async function go(handle, prefix, depth) {
      const kids = [];
      for await (const [name, h] of handle.entries()) kids.push([name, h]);
      kids.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, h] of kids) {
        if (out.length > 15000) return;
        const p = prefix ? `${prefix}/${name}` : name;
        if (h.kind === 'directory') {
          if (IGNORED_DIRS.has(name)) continue;
          out.push({ path: p, type: 'dir' });
          if (depth + 1 < maxDepth) await go(h, p, depth + 1);
        } else out.push({ path: p, type: 'file' });
      }
    }
    await go(dir, '', 0);
    return out;
  }
  async function resolve(path, { create = false, file = true } = {}) {
    const parts = path.replace(/^\.?\/*/, '').split('/').filter(Boolean);
    if (parts.some((p) => p === '..')) throw new Error('Path escapes workspace');
    let h = dir;
    for (let i = 0; i < parts.length - (file ? 1 : 0); i++) h = await h.getDirectoryHandle(parts[i], { create });
    return { parent: h, name: parts[parts.length - 1] };
  }
  const read = async (path) => {
    try {
      const { parent, name } = await resolve(path);
      const f = await (await parent.getFileHandle(name)).getFile();
      return await f.text();
    } catch (e) {
      if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') throw new Error(`File not found: ${path}`);
      throw e;
    }
  };
  const files = async () => (await walk()).filter((e) => e.type === 'file').map((e) => e.path);
  return {
    kind: 'browser folder',
    type: 'folder',
    name: dir.name,
    root: dir.name,
    capabilities: { exec: false, fetch: true },
    async list(path = '.', depth = 2) {
      const base = path === '.' ? '' : path.replace(/^\.\//, '');
      return filterDepth(await walk(base ? Infinity : depth), base, depth);
    },
    read,
    async write(path, content) {
      const { parent, name } = await resolve(path, { create: true });
      const fh = await parent.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(content);
      await w.close();
    },
    async remove(path) {
      const { parent, name } = await resolve(path);
      await parent.removeEntry(name);
    },
    search: async (pattern, { path, glob, limit } = {}) => {
      let list = await files();
      if (path && path !== '.') list = list.filter((f) => f.startsWith(path.replace(/^\.\//, '').replace(/\/$/, '') + '/'));
      return searchFiles({ files: list, read, pattern, glob, limit });
    },
    glob: async (pattern) => matchGlob(await files(), pattern),
    fetchUrl: fetchText,
    webSearch: browserSearch,
    run: async () => ({ code: 127, stdout: '', stderr: 'Commands are not available in browser mode.' }),
  };
}

// ── Sandbox (virtual files in localStorage) ──
const SANDBOX_KEY = 'buddo-sandbox';
export function loadSandbox() {
  try {
    return JSON.parse(localStorage.getItem(SANDBOX_KEY)) || {};
  } catch {
    return {};
  }
}
function saveSandbox(files) {
  try {
    localStorage.setItem(SANDBOX_KEY, JSON.stringify(files));
  } catch {}
}

export function sandboxWorkspace(name = 'sandbox') {
  const files = loadSandbox();
  const norm = (p) => p.replace(/^\.?\/*/, '').replace(/\/+/g, '/');
  const list = () => {
    const dirs = new Set();
    const out = [];
    for (const f of Object.keys(files).sort()) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (!dirs.has(d)) {
          dirs.add(d);
          out.push({ path: d, type: 'dir' });
        }
      }
      out.push({ path: f, type: 'file' });
    }
    return out;
  };
  const read = async (p) => {
    const k = norm(p);
    if (!(k in files)) throw new Error(`File not found: ${p}`);
    return files[k];
  };
  return {
    kind: 'browser sandbox',
    type: 'sandbox',
    name,
    root: name,
    capabilities: { exec: false, fetch: true },
    files,
    async list(path = '.', depth = 2) {
      return filterDepth(list(), path === '.' ? '' : norm(path), depth);
    },
    read,
    async write(p, content) {
      files[norm(p)] = content;
      saveSandbox(files);
    },
    async remove(p) {
      delete files[norm(p)];
      saveSandbox(files);
    },
    clear() {
      for (const k of Object.keys(files)) delete files[k];
      saveSandbox(files);
    },
    search: async (pattern, { path, glob, limit } = {}) => {
      let l = Object.keys(files);
      if (path && path !== '.') l = l.filter((f) => f.startsWith(norm(path).replace(/\/$/, '') + '/'));
      return searchFiles({ files: l, read, pattern, glob, limit });
    },
    glob: async (pattern) => matchGlob(Object.keys(files), pattern),
    fetchUrl: fetchText,
    webSearch: browserSearch,
    run: async () => ({ code: 127, stdout: '', stderr: 'Commands are not available in the browser sandbox.' }),
  };
}

// ── Live preview: inline local CSS/JS into index.html so it renders in an iframe ──
export async function buildPreview(ws, entry) {
  const htmls = await ws.glob('**/*.html').catch(() => []);
  if (!htmls.length) return null;
  const pick = [entry, 'index.html', 'public/index.html', 'src/index.html', 'dist/index.html'].find((c) => c && htmls.includes(c)) || htmls[0];
  const html0 = await ws.read(pick).catch(() => null);
  if (html0 === null) return null;
  let html = html0;
  const base = pick.includes('/') ? pick.slice(0, pick.lastIndexOf('/') + 1) : '';
  const resolvePath = (href) => {
    if (/^(https?:)?\/\//.test(href) || href.startsWith('data:')) return null;
    const parts = (href.startsWith('/') ? href.slice(1) : base + href).split('/');
    const out = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.' && p !== '') out.push(p);
    }
    return out.join('/');
  };
  const replaceAsync = async (str, re, fn) => {
    const jobs = [];
    str.replace(re, (...m) => jobs.push(fn(...m)));
    const results = await Promise.all(jobs);
    let i = 0;
    return str.replace(re, () => results[i++]);
  };
  html = await replaceAsync(html, /<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, async (tag) => {
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    const p = href && resolvePath(href);
    if (!p) return tag;
    try {
      return `<style>/* ${p} */\n${await ws.read(p)}\n</style>`;
    } catch {
      return tag;
    }
  });
  html = await replaceAsync(html, /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi, async (tag, pre, src, post) => {
    const p = resolvePath(src);
    if (!p) return tag;
    try {
      const code = (await ws.read(p)).replace(/<\/script>/gi, '<\\/script>');
      return `<script${pre}${post}>/* ${p} */\n${code}\n</script>`;
    } catch {
      return tag;
    }
  });
  // The preview iframe is sandboxed without same-origin access, so storage APIs throw.
  // Give the page an in-memory stand-in so apps that save data still work.
  const shim = `<script>(function(){try{localStorage.length}catch(e){var mk=function(){var m={};return{getItem:function(k){return k in m?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}}};Object.defineProperty(window,'localStorage',{value:mk()});Object.defineProperty(window,'sessionStorage',{value:mk()})}})()</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + shim) : shim + html;
}

// ── persist the browser folder handle across reloads (IndexedDB) ──
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('buddo', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function saveHandle(handle) {
  try {
    const db = await idb();
    db.transaction('kv', 'readwrite').objectStore('kv').put(handle, 'folder');
  } catch {}
}
export async function loadHandle() {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const r = db.transaction('kv').objectStore('kv').get('folder');
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}
