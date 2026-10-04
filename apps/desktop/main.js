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
// New versions are GitHub releases with one file, Buddo-Setup.exe (every push to main releases one). Buddo checks
// on start and every few hours, downloads a new version quietly in the background, then installs it silently:
// right away when the user clicks "Restart to update" (and opens again), or else when they quit Buddo.
// Mac and Linux builds aren't released, so there it opens the Releases page instead.
const REPO = 'arthurknielsen/buddo';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const newer = (a, b) => {
  const p = (v) => String(v).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
let update = null; // { version, url, size, notes, page }
let downloading = null; // promise of the downloaded installer's path
let ready = null; // { version, file }: downloaded, installs on restart or quit
let installing = false;
const sendUpdate = (msg) => win && !win.isDestroyed() && win.webContents.send('buddo:update', msg);
const canSelfInstall = () => process.platform === 'win32' && app.isPackaged;

async function checkForUpdate() {
  const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Buddo' } });
  if (!r.ok) throw new Error(r.status === 404 ? 'No releases yet.' : `GitHub answered ${r.status}.`);
  const rel = await r.json();
  const exe = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
  const current = app.getVersion();
  const available = newer(rel.tag_name, current);
  update = available ? { version: rel.tag_name.replace(/^v/, ''), url: exe?.browser_download_url || null, size: exe?.size || 0, notes: (rel.body || '').slice(0, 2000), page: rel.html_url || RELEASES } : null;
  const info = { current, latest: rel.tag_name.replace(/^v/, ''), available, canInstall: available && canSelfInstall() && !!exe, ready: !!ready && ready.version === update?.version, ...(update || {}) };
  // Get it ready in the background: the user only ever sees "Restart to update".
  if (info.canInstall && !info.ready) downloadUpdate().catch(() => {});
  return info;
}

function downloadUpdate() {
  if (ready && ready.version === update?.version) return Promise.resolve(ready.file);
  if (downloading) return downloading;
  const want = update;
  downloading = (async () => {
    const file = path.join(app.getPath('temp'), `Buddo-Setup-${want.version}.exe`);
    const r = await net.fetch(want.url);
    if (!r.ok || !r.body) throw new Error(`Download failed (${r.status}).`);
    const total = Number(r.headers.get('content-length')) || want.size || 0;
    const part = `${file}.part`;
    const out = fs.createWriteStream(part);
    let got = 0;
    let last = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((ok) => out.once('drain', ok));
      if (Date.now() - last > 250) {
        last = Date.now();
        sendUpdate({ stage: 'download', got, total, version: want.version });
      }
    }
    await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
    if (total && got < total) throw new Error('The download was cut off. It will try again later.');
    fs.renameSync(part, file);
    ready = { version: want.version, file };
    sendUpdate({ stage: 'ready', version: want.version });
    return file;
  })().finally(() => {
    downloading = null;
  });
  downloading.catch((e) => sendUpdate({ stage: 'error', error: e.message }));
  return downloading;
}

/** Install now: silently, then Buddo opens again on the new version. */
async function installUpdate() {
  if (!update) await checkForUpdate();
  if (!update) return { ok: false, error: 'Buddo is already up to date.' };
  if (!canSelfInstall() || !update.url) {
    shell.openExternal(update.page);
    return { ok: true, opened: true };
  }
  const file = await downloadUpdate();
  sendUpdate({ stage: 'install' });
  runInstaller(file, true);
  setTimeout(() => app.quit(), 400);
  return { ok: true };
}

// /S: silent (no installer window). --force-run: open Buddo again afterwards.
function runInstaller(file, reopen) {
  if (installing) return;
  installing = true;
  spawn(file, reopen ? ['/S', '--force-run'] : ['/S'], { detached: true, stdio: 'ignore' }).unref();
}

// Downloaded but not installed yet: install quietly as Buddo closes.
app.on('before-quit', () => {
  if (ready && !installing && fs.existsSync(ready.file)) runInstaller(ready.file, false);
});

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
  const look = () => checkForUpdate().then((u) => u.available && sendUpdate({ stage: 'available', ...u })).catch(() => {});
  setTimeout(look, 4000);
  setInterval(look, 4 * 60 * 60 * 1000);
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && boot());
});
app.on('window-all-closed', () => {
  server?.close();
  if (process.platform !== 'darwin') app.quit();
});
