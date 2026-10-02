// Lets Buddo screenshot/record pages with Electron's own Chromium (no external browser needed).
import { BrowserWindow } from 'electron';

export function electronBrowserProvider() {
  return {
    name: 'electron',
    available: () => true,
    async open({ width, height }) {
      const win = new BrowserWindow({
        show: false,
        width,
        height,
        useContentSize: true,
        paintWhenInitiallyHidden: true,
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      win.webContents.setFrameRate(30);
      win.webContents.setAudioMuted(true);
      const logs = [];
      const failed = [];
      win.webContents.on('console-message', (e, level, message) => {
        const lvl = typeof e?.level === 'string' ? e.level : level;
        const text = typeof e?.message === 'string' ? e.message : message;
        if (lvl === 'error' || lvl === 3) logs.push({ type: 'error', text });
        else if (lvl === 'warning' || lvl === 2) logs.push({ type: 'warning', text });
      });
      win.webContents.on('did-fail-load', (_e, code, desc, url) => failed.push(`${desc} ${url}`));
      win.webContents.session.webRequest.onCompleted({ urls: ['*://*/*'] }, (d) => d.statusCode >= 400 && d.webContentsId === win.webContents.id && failed.push(`${d.statusCode} ${d.url}`));
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const run = (fn, arg) => win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`, true);
      return {
        logs,
        failed,
        async goto(url) {
          await win.loadURL(url).catch((e) => failed.push(String(e.message || e)));
          await new Promise((r) => setTimeout(r, 450));
        },
        async eval(fn, arg) {
          try {
            return await run(fn, arg);
          } catch (e) {
            throw new Error(String(e.message || e).replace(/^.*Uncaught Error:\s*/, ''));
          }
        },
        async screenshot({ full }) {
          if (!full) return (await win.webContents.capturePage()).toPNG();
          const h = Math.min(8000, await run(() => document.documentElement.scrollHeight));
          win.setContentSize(width, h);
          await new Promise((r) => setTimeout(r, 300));
          const png = (await win.webContents.capturePage()).toPNG();
          win.setContentSize(width, height);
          return png;
        },
        async close() {
          if (!win.isDestroyed()) win.destroy();
        },
      };
    },
  };
}
