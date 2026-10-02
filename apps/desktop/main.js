// Buddo desktop: starts the local Buddo server in-process and shows the UI in a native window.
import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

async function boot() {
  const { startServer, webDir } = await loadServer();
  let root = readState().root;
  if (!root || !fs.existsSync(root)) {
    root = path.join(os.homedir(), 'Buddo Projects');
    fs.mkdirSync(root, { recursive: true });
  }
  for (let port = 41410; port < 41430; port++) {
    try {
      server = await startServer({ port, root, webDir, log: () => {} });
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

ipcMain.handle('buddo:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  await boot();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && boot());
});
app.on('window-all-closed', () => {
  server?.close();
  if (process.platform !== 'darwin') app.quit();
});
