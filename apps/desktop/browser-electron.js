// Lets Buddo screenshot/record pages with Electron's own Chromium (no external browser needed).
import { BrowserWindow } from 'electron';

let windows = 0;

export function electronBrowserProvider() {
  return {
    name: 'electron',
    available: () => true,
    async open({ width, height, init, transparent = false }) {
      const win = new BrowserWindow({
        show: false,
        // Transparent only when asked (make_video overlays); normal pages keep the browser's white.
        ...(transparent ? { transparent: true, backgroundColor: '#00000000' } : {}),
        width,
        height,
        useContentSize: true,
        paintWhenInitiallyHidden: true,
        // Its own throwaway session: the request watcher below must never see (or outlive into) the app's own
        // window, whose requests share the default session. A watcher left on it after this window closed read
        // win.webContents on the next failed request and crashed the app ("Object has been destroyed").
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `buddo-shot-${++windows}` },
      });
      const wc = win.webContents;
      const wcId = wc.id;
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
      const requests = wc.session.webRequest;
      requests.onCompleted({ urls: ['*://*/*'] }, (d) => d.statusCode >= 400 && d.webContentsId === wcId && failed.push(`${d.statusCode} ${d.url}`));
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      // Run `init` before any page script (make_video's virtual clock), like Playwright's addInitScript.
      if (init) {
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Page.enable');
        await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: init });
      }
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
        async screenshot({ full, format }) {
          if (format === 'jpeg') return (await win.webContents.capturePage()).toJPEG(95);
          if (!full) return (await win.webContents.capturePage()).toPNG();
          const h = Math.min(8000, await run(() => document.documentElement.scrollHeight));
          win.setContentSize(width, h);
          await new Promise((r) => setTimeout(r, 300));
          const png = (await win.webContents.capturePage()).toPNG();
          win.setContentSize(width, height);
          return png;
        },
        async close() {
          requests.onCompleted(null);
          if (!win.isDestroyed()) win.destroy();
        },
      };
    },
  };
}
