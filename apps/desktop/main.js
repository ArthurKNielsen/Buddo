// Buddo desktop: starts the local Buddo server in-process and shows the UI in a native window.
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { electronBrowserProvider } from './browser-electron.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const statePath = () => path.join(app.getPath('userData'), 'state.json');
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
};
const writeState = (s) => {
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...s }));
  } catch {}
};

async function loadServer() {
  const packaged = path.join(here, 'app/node_modules/@buddo/server/src/index.js');
  const dev = path.resolve(here, '../../packages/server/src/index.js');
  const mod = await import(pathToFileURL(fs.existsSync(packaged) ? packaged : dev).href);
  const webDir = [path.join(here, 'app/web'), path.resolve(here, '../web/dist')].find((d) => fs.existsSync(path.join(d, 'index.html')));
  return { startServer: mod.startServer, webDir };
}

let server;
let win;

// Buddo's own home folder. In it every chat gets its own folder (chats/<id>) and can't see the others' files;
// a project folder the user opens is shared by every chat on purpose.
const HOME = path.join(os.homedir(), 'Buddo Projects');

async function boot() {
  const { startServer, webDir } = await loadServer();
  let root = readState().root;
  if (!root || !fs.existsSync(root)) {
    root = HOME;
    fs.mkdirSync(root, { recursive: true });
  }
  for (let port = 41410; port < 41430; port++) {
    try {
      server = await startServer({ port, root, webDir, log: () => {}, browserProvider: electronBrowserProvider(), chatFolders: (r) => path.resolve(r) === path.resolve(HOME) });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  // Remember the folder whenever the UI switches workspace.
  setInterval(() => server?.workspace && writeState({ root: server.workspace.root }), 5000);

  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#08080b',
    title: 'Buddo',
    icon: path.join(here, 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 18 },
    show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(server.url)) shell.openExternal(url);
    return { action: url.startsWith('blob:') ? 'allow' : 'deny' };
  });
  await win.loadURL(`${server.url}/app`);
}

// ── Updates ──
// New versions are GitHub releases with one file, Buddo-Setup.exe. Buddo checks the latest release on start (and
// when asked), downloads the installer with progress, then runs it: the one-click installer replaces this copy
// and opens the new one. Mac and Linux builds aren't released, so there it opens the Releases page instead.
const REPO = 'arthurknielsen/buddo';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const newer = (a, b) => {
  const p = (v) => String(v).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
let update = null; // { version, url, size, notes }
let downloading = null;
const sendUpdate = (msg) => win && !win.isDestroyed() && win.webContents.send('buddo:update', msg);

async function checkForUpdate() {
  const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Buddo' } });
  if (!r.ok) throw new Error(r.status === 404 ? 'No releases yet.' : `GitHub answered ${r.status}.`);
  const rel = await r.json();
  const exe = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
  const current = app.getVersion();
  const available = newer(rel.tag_name, current);
  update = available ? { version: rel.tag_name.replace(/^v/, ''), url: exe?.browser_download_url || null, size: exe?.size || 0, notes: (rel.body || '').slice(0, 2000), page: rel.html_url || RELEASES } : null;
  return { current, latest: rel.tag_name.replace(/^v/, ''), available, canInstall: available && process.platform === 'win32' && !!exe, ...(update || {}) };
}

async function installUpdate() {
  if (!update) await checkForUpdate();
  if (!update) return { ok: false, error: 'Buddo is already up to date.' };
  if (process.platform !== 'win32' || !update.url) {
    shell.openExternal(update.page);
    return { ok: true, opened: true };
  }
  if (downloading) return downloading;
  downloading = (async () => {
    const file = path.join(app.getPath('temp'), `Buddo-Setup-${update.version}.exe`);
    const r = await net.fetch(update.url);
    if (!r.ok || !r.body) throw new Error(`Download failed (${r.status}).`);
    const total = Number(r.headers.get('content-length')) || update.size || 0;
    const out = fs.createWriteStream(file);
    let got = 0;
    let last = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((ok) => out.once('drain', ok));
      if (Date.now() - last > 150) {
        last = Date.now();
        sendUpdate({ stage: 'download', got, total });
      }
    }
    await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
    if (total && got < total) throw new Error('The download was cut off. Try again.');
    sendUpdate({ stage: 'install' });
    // The installer closes this copy itself; start it detached, then quit so files aren't in use.
    spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 600);
    return { ok: true };
  })().catch((e) => {
    downloading = null;
    sendUpdate({ stage: 'error', error: e.message });
    return { ok: false, error: e.message };
  });
  return downloading;
}

ipcMain.handle('buddo:update-check', () => checkForUpdate().catch((e) => ({ error: e.message, current: app.getVersion() })));
ipcMain.handle('buddo:update-install', () => installUpdate().catch((e) => ({ ok: false, error: e.message })));
ipcMain.handle('buddo:version', () => app.getVersion());

ipcMain.handle('buddo:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  await boot();
  // Look for a new version a few seconds after start (quietly: no internet is fine).
  setTimeout(() => checkForUpdate().then((u) => u.available && sendUpdate({ stage: 'available', ...u })).catch(() => {}), 4000);
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && boot());
});
app.on('window-all-closed', () => {
  server?.close();
  if (process.platform !== 'darwin') app.quit();
});
