// Buddo local server: exposes a workspace (files + shell) to the web UI, proxies
// local model servers (Ollama / LM Studio) and serves the built web app.
// Zero dependencies. Binds to 127.0.0.1 only.

import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { createNodeWorkspace, loadMedia, loadProfile, saveProfile } from '@buddo/core/node';
import { normalizeProfile } from '@buddo/core';
import crypto from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isObj ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function json(req) {
  const b = await readBody(req);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
}

export async function startServer({ port = 4141, host = '127.0.0.1', root = process.cwd(), webDir, log = console.log, browserProvider } = {}) {
  const wsOpts = { browserProvider };
  let workspace = createNodeWorkspace(root, wsOpts);
  // Token for <img>/<video> previews of workspace files (those requests can't send custom headers).
  const rawToken = crypto.randomBytes(16).toString('hex');
  // Warm up the senses in the background so the first watch/listen is instant.
  loadMedia()
    .then((m) => m.modelStatus().every((x) => x.installed) && m.preload())
    .catch(() => {});

  async function api(req, res, url) {
    const p = url.pathname;
    const q = url.searchParams;

    if (p === '/api/health') return send(res, 200, { ok: true, app: 'buddo', version: '1.0.0', platform: process.platform });
    if (p === '/api/workspace' && req.method === 'GET') {
      return send(res, 200, { name: workspace.name, root: workspace.root, capabilities: workspace.capabilities, home: os.homedir(), sep: path.sep, rawToken });
    }
    if (p === '/api/workspace' && req.method === 'POST') {
      const { root: next } = await json(req);
      const full = path.resolve(next.replace(/^~(?=$|[\\/])/, os.homedir()));
      const st = await fs.stat(full).catch(() => null);
      if (!st?.isDirectory()) return send(res, 400, { error: `Not a folder: ${full}` });
      workspace = createNodeWorkspace(full, wsOpts);
      log(`  workspace → ${full}`);
      return send(res, 200, { name: workspace.name, root: workspace.root, capabilities: workspace.capabilities });
    }
    if (p === '/api/workspace/create' && req.method === 'POST') {
      const { parent, name } = await json(req);
      if (!name || /[\\/]/.test(name)) return send(res, 400, { error: 'Invalid folder name' });
      const full = path.resolve(parent || os.homedir(), name);
      await fs.mkdir(full, { recursive: true });
      return send(res, 200, { path: full });
    }
    // Folder browser for the "Open folder" dialog.
    if (p === '/api/dirs') {
      const dir = path.resolve((q.get('path') || os.homedir()).replace(/^~(?=$|[\\/])/, os.homedir()));
      const items = await fs.readdir(dir, { withFileTypes: true }).catch((e) => {
        throw new Error(`Cannot open ${dir}: ${e.code || e.message}`);
      });
      const dirs = items
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b));
      const isProject = items.some((d) => ['package.json', '.git', 'pyproject.toml', 'Cargo.toml', 'go.mod'].includes(d.name));
      return send(res, 200, { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs, isProject, home: os.homedir() });
    }
    if (p === '/api/fs/raw') {
      const full = path.resolve(workspace.root, (q.get('path') || '').replace(/^\/+/, ''));
      if (full !== workspace.root && !full.startsWith(workspace.root + path.sep)) return send(res, 403, { error: 'Outside workspace' });
      const st = await fs.stat(full).catch(() => null);
      if (!st?.isFile()) return send(res, 404, { error: 'Not found' });
      const ext = path.extname(full).toLowerCase();
      const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' }[ext] || 'application/octet-stream';
      // Range support so <video>/<audio> can seek.
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const startB = range[1] ? Number(range[1]) : 0;
        const endB = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
        res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${startB}-${endB}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': endB - startB + 1 });
        return createReadStream(full, { start: startB, end: endB }).pipe(res);
      }
      res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' });
      return createReadStream(full).pipe(res);
    }
    if (p === '/api/fs/list') return send(res, 200, { entries: await workspace.list(q.get('path') || '.', Number(q.get('depth')) || 2) });
    if (p === '/api/fs/read') return send(res, 200, { content: await workspace.read(q.get('path')) });
    if (p === '/api/fs/write' && req.method === 'POST') {
      const b = await json(req);
      await workspace.write(b.path, b.content ?? '');
      return send(res, 200, { ok: true });
    }
    // Videos, music and pictures dropped into the chat (raw bytes, not JSON).
    if (p === '/api/fs/upload' && req.method === 'POST') {
      await workspace.writeBinary(q.get('path') || '', await readBody(req, 1024 * 1024 * 1024));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/fs/remove' && req.method === 'POST') {
      await workspace.remove((await json(req)).path);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/fs/search' && req.method === 'POST') {
      const b = await json(req);
      return send(res, 200, { hits: await workspace.search(b.pattern, b) });
    }
    if (p === '/api/fs/glob' && req.method === 'POST') return send(res, 200, { files: await workspace.glob((await json(req)).pattern) });
    if (p === '/api/exec' && req.method === 'POST') {
      const b = await json(req);
      // Streams output as NDJSON: {type:'data', text} … {type:'exit', code, stdout, stderr}
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
      const r = await workspace.run(b.command, {
        cwd: b.cwd,
        timeout: Math.min(Number(b.timeout) || 120000, 600000),
        onData: (text) => res.write(JSON.stringify({ type: 'data', text }) + '\n'),
      });
      res.end(JSON.stringify({ type: 'exit', ...r }) + '\n');
      return;
    }
    if (p === '/api/websearch' && req.method === 'POST') {
      const b = await json(req);
      return send(res, 200, await workspace.webSearch(b.query, { source: b.source }));
    }
    if (p === '/api/profile' && req.method === 'GET') return send(res, 200, loadProfile());
    if (p === '/api/profile' && req.method === 'PUT') {
      const next = normalizeProfile(await json(req));
      saveProfile(next);
      return send(res, 200, next);
    }
    if (p === '/api/browser/status') {
      const m = await loadMedia().catch(() => null);
      return send(res, 200, { available: !!(m && m.browserAvailable(browserProvider)), provider: browserProvider ? browserProvider.name : 'chrome' });
    }
    if (p.startsWith('/api/media/') && req.method === 'POST' && ['watch_video', 'listen_audio', 'view_image', 'screenshot', 'record_video', 'make_video', 'edit_video'].includes(p.slice(11))) {
      return send(res, 200, await workspace.media[p.slice(11)](await json(req)));
    }
    if (p === '/api/media/status') {
      try {
        const m = await loadMedia();
        return send(res, 200, { available: true, models: m.modelStatus(), ffmpeg: m.FFMPEG });
      } catch (e) {
        return send(res, 200, { available: false, error: e.message, models: [] });
      }
    }
    if (p === '/api/media/setup' && req.method === 'POST') {
      // Streams download progress as NDJSON.
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
      try {
        const m = await loadMedia();
        let last = 0;
        await m.ensureAll((ev) => {
          const now = Date.now();
          if (ev.stage || now - last > 150) {
            last = now;
            res.write(JSON.stringify({ type: 'progress', ...ev }) + '\n');
          }
        });
        await m.preload();
        res.end(JSON.stringify({ type: 'done', models: m.modelStatus() }) + '\n');
      } catch (e) {
        res.end(JSON.stringify({ type: 'error', error: e.message }) + '\n');
      }
      return;
    }
    // Describe an image the user pasted into the chat (for models that can't see images).
    if (p === '/api/media/describe' && req.method === 'POST') {
      const { name = 'image.png', data } = await json(req);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'buddo-img-'));
      const file = path.join(dir, path.basename(name).replace(/[^\w.-]/g, '_') || 'image.png');
      try {
        await fs.writeFile(file, Buffer.from(data, 'base64'));
        const r = await (await loadMedia()).viewImage(file);
        return send(res, 200, { text: r.text.replace(/^IMAGE [^—]*/, `IMAGE ${name} `), objects: r.display.objects });
      } finally {
        fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (p === '/api/fetch' && req.method === 'POST') return send(res, 200, { text: await workspace.fetchUrl((await json(req)).url) });
    return send(res, 404, { error: 'Not found' });
  }

  // Proxy to a local model server (avoids CORS issues). Target must be local.
  async function llmProxy(req, res, url) {
    const target = req.headers['x-buddo-target'] || 'http://127.0.0.1:11434';
    let t;
    try {
      t = new URL(target);
    } catch {
      return send(res, 400, { error: 'Bad target' });
    }
    if (!LOCAL_HOSTS.has(t.hostname)) return send(res, 403, { error: 'Only local model servers can be proxied.' });
    if (t.hostname === 'localhost') t.hostname = '127.0.0.1';
    const dest = t.origin + t.pathname.replace(/\/$/, '') + url.pathname.replace(/^\/llm/, '') + url.search;
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    let upstream;
    try {
      upstream = await fetch(dest, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' }, body, signal: ctrl.signal });
    } catch (e) {
      return send(res, 502, { error: `Can't reach ${t.origin} — is it running? (${e.cause?.code || e.message})` });
    }
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-cache' });
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body)
      .on('error', () => res.end())
      .pipe(res);
  }

  async function serveStatic(req, res, url) {
    if (!webDir) return send(res, 200, 'Buddo server is running. Build the web app (npm run build) to serve the UI here.');
    let rel = decodeURIComponent(url.pathname);
    let file = path.join(webDir, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(webDir)) return send(res, 403, 'Forbidden');
    let st = await fs.stat(file).catch(() => null);
    if (!st || st.isDirectory()) {
      file = path.join(webDir, 'index.html');
      st = await fs.stat(file).catch(() => null);
      if (!st) return send(res, 404, 'Not found');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/llm/') || url.pathname === '/llm';
    try {
      if (isApi) {
        // CSRF protection: a custom header forces a CORS preflight, which we never approve,
        // so other websites can't drive this local server.
        if (req.method === 'OPTIONS') return send(res, 403, 'CORS not allowed');
        const rawOk = url.pathname === '/api/fs/raw' && url.searchParams.get('token') === rawToken && req.method === 'GET';
        if (req.headers['x-buddo'] !== '1' && !rawOk) return send(res, 403, { error: 'Missing x-buddo header' });
        const origin = req.headers.origin;
        if (origin) {
          const o = new URL(origin);
          if (o.host !== req.headers.host && !LOCAL_HOSTS.has(o.hostname)) return send(res, 403, { error: 'Bad origin' });
        }
        if (url.pathname.startsWith('/llm')) return await llmProxy(req, res, url);
        return await api(req, res, url);
      }
      return await serveStatic(req, res, url);
    } catch (err) {
      const msg = err?.message || String(err);
      if (!res.headersSent) send(res, /not found|ENOENT/i.test(msg) ? 404 : /outside the workspace/.test(msg) ? 403 : 500, { error: msg });
      else res.end();
    }
  });

  // Making or editing a long video can take minutes; don't cut the request off at Node's 5-minute default.
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  return {
    server,
    port: addr.port,
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}`,
    get workspace() {
      return workspace;
    },
    setRoot(dir) {
      workspace = createNodeWorkspace(dir, wsOpts);
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
