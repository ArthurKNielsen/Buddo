// See its own work: screenshot / record web pages Buddo builds, run simple actions,
// and report what a human would notice (console errors, broken images, overflow…).
//
// Providers: Electron's offscreen browser (desktop app, passed in) or a locally installed
// Chrome / Edge / Chromium driven by playwright-core (CLI, `buddo web`). No browser download needed.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ffmpeg } from './ffmpeg.js';

export const SIZES = { desktop: [1280, 800], laptop: [1440, 900], tablet: [820, 1180], mobile: [390, 844], phone: [390, 844] };

export function parseSize(size = 'desktop') {
  const s = String(size).trim().toLowerCase();
  if (SIZES[s]) return SIZES[s];
  const m = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(s);
  return m ? [Math.min(2560, Number(m[1])), Math.min(2560, Number(m[2]))] : SIZES.desktop;
}

/** "click #add\ntype #input Buy milk\npress Enter\nscroll 600\nwait 500" → actions */
export function parseActions(text = '') {
  return String(text)
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 40)
    .map((l) => {
      const [verb, ...rest] = l.split(/\s+/);
      const arg = rest.join(' ');
      switch (verb.toLowerCase()) {
        case 'click':
        case 'tap':
          return { type: 'click', target: arg.replace(/^["']|["']$/g, '') };
        case 'hover':
          return { type: 'hover', target: arg };
        case 'type':
        case 'fill': {
          const m = /^("[^"]+"|'[^']+'|\S+)\s+([\s\S]*)$/.exec(arg);
          return { type: 'type', target: (m?.[1] || arg).replace(/^["']|["']$/g, ''), text: (m?.[2] || '').replace(/^["']|["']$/g, '') };
        }
        case 'press':
          return { type: 'press', key: arg || 'Enter' };
        case 'scroll':
          return { type: 'scroll', px: arg === 'bottom' ? 99999 : arg === 'top' ? -99999 : parseInt(arg, 10) || 600 };
        case 'wait':
        case 'sleep':
          return { type: 'wait', ms: Math.min(10000, parseInt(arg, 10) || 500) };
        default:
          return { type: 'unknown', raw: l };
      }
    });
}

// Runs inside the page. Must be self-contained.
export const PAGE_ACTION = function (a) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const find = (target) => {
    try {
      const el = document.querySelector(target);
      if (el) return el;
    } catch {}
    const t = target.toLowerCase();
    const pools = ['button, a, [role=button], input[type=submit], input[type=button], summary, label', 'input, textarea, select', '*'];
    for (const sel of pools) {
      const els = [...document.querySelectorAll(sel)].filter(visible);
      const exact = els.find((e) => (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().toLowerCase() === t);
      if (exact) return exact;
      const part = els.find((e) => (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(t) && (sel !== '*' || e.children.length === 0));
      if (part) return part;
    }
    return null;
  };
  const describe = (el) => `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}> "${(el.innerText || el.value || el.placeholder || '').trim().slice(0, 40)}"`;
  if (a.type === 'scroll') {
    window.scrollBy(0, a.px);
    return `scrolled to y=${Math.round(window.scrollY)}`;
  }
  if (a.type === 'press') {
    const el = document.activeElement || document.body;
    const opts = { key: a.key, code: a.key, bubbles: true, cancelable: true };
    const ok = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (ok && a.key === 'Enter' && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    return `pressed ${a.key} on ${describe(el)}`;
  }
  const el = find(a.target);
  if (!el) throw new Error(`could not find "${a.target}"`);
  el.scrollIntoView({ block: 'center' });
  if (a.type === 'click') {
    el.focus?.();
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    el.click();
    return `clicked ${describe(el)}`;
  }
  if (a.type === 'hover') {
    for (const t of ['pointerover', 'mouseover', 'mouseenter']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, view: window }));
    return `hovered ${describe(el)}`;
  }
  if (a.type === 'type') {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (el.isContentEditable) el.textContent = a.text;
    else if (setter) setter.call(el, a.text);
    else el.value = a.text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `typed "${a.text}" into ${describe(el)}`;
  }
  throw new Error(`unknown action ${a.type}`);
};

// Runs inside the page: what a reviewer would notice.
export const PAGE_REPORT = function () {
  const vw = document.documentElement.clientWidth;
  const doc = document.documentElement;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const overflow = [];
  if (doc.scrollWidth > vw + 2) {
    const wide = [...document.body.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.right > vw + 2 && r.width > 0 && getComputedStyle(el).position !== 'fixed';
    });
    // Report the culprits (innermost overflowing elements), not every ancestor that inherits the width.
    for (const el of wide.filter((el) => !wide.some((o) => o !== el && el.contains(o))).slice(0, 4)) {
      const r = el.getBoundingClientRect();
      overflow.push(`<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''}> sticks out ${Math.round(r.right - vw)}px (width ${Math.round(r.width)}px)`);
    }
  }
  const brokenImages = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.src).map((i) => i.src.split('/').pop()).slice(0, 5);
  const tiny = [...document.querySelectorAll('p, li, a, button, span, label')].filter((e) => visible(e) && e.innerText?.trim() && parseFloat(getComputedStyle(e).fontSize) < 11).length;
  const controls = [...document.querySelectorAll('button, a[href], input, textarea, select, [role=button]')]
    .filter(visible)
    .slice(0, 20)
    .map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.type && e.tagName === 'INPUT' ? `[${e.type}]` : ''} "${(e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 30)}"`);
  const text = (document.body?.innerText || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    title: document.title,
    url: location.href,
    viewport: `${vw}×${window.innerHeight}`,
    pageHeight: doc.scrollHeight,
    overflowX: doc.scrollWidth > vw + 2 ? doc.scrollWidth - vw : 0,
    overflow,
    brokenImages,
    tinyText: tiny,
    empty: !text && document.body.querySelectorAll('canvas, svg, img, video').length === 0,
    controls,
    text: text.slice(0, 900),
  };
};

// ───────── Browser providers ─────────

function findChrome() {
  if (process.env.BUDDO_CHROME && fs.existsSync(process.env.BUDDO_CHROME)) return process.env.BUDDO_CHROME;
  const home = os.homedir();
  const c = [];
  if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Arc.app/Contents/MacOS/Arc');
  } else if (process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      c.push(path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe'), path.join(base, 'BraveSoftware/Brave-Browser/Application/brave.exe'));
    }
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      try {
        c.push(execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      } catch {}
    }
  }
  // Browsers installed by Playwright (e.g. `npx playwright install chromium`).
  const pw = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, '.cache/ms-playwright'), path.join(home, 'Library/Caches/ms-playwright'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean);
  for (const dir of pw) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir).filter((d) => /^chromium-\d+/.test(d)).sort().reverse();
    } catch {}
    for (const d of entries) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) c.push(path.join(dir, d, rel));
    }
  }
  return c.find((p) => p && fs.existsSync(p)) || null;
}

let pwBrowser = null;
let idleTimer = null;

/** Drives an installed Chrome/Edge with playwright-core (no download). */
export function chromeProvider() {
  return {
    name: 'chrome',
    available: () => !!findChrome(),
    async open({ width, height }) {
      const exe = findChrome();
      if (!exe) throw new Error('No Chrome, Edge or Chromium found. Install Google Chrome (or set BUDDO_CHROME to a browser path), or use the Buddo desktop app.');
      if (!pwBrowser) {
        const { chromium } = await import('playwright-core');
        pwBrowser = chromium.launch({ executablePath: exe, headless: true, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
      }
      clearTimeout(idleTimer);
      const browser = await pwBrowser;
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const logs = [];
      const failed = [];
      page.on('console', (m) => ['error', 'warning'].includes(m.type()) && logs.push({ type: m.type(), text: m.text() }));
      page.on('pageerror', (e) => logs.push({ type: 'error', text: String(e.message || e) }));
      page.on('requestfailed', (r) => failed.push(r.url()));
      page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));
      return {
        logs,
        failed,
        goto: async (url) => {
          await page.goto(url, { waitUntil: 'load', timeout: 20000 });
          await page.waitForTimeout(350);
        },
        eval: (fn, arg) => page.evaluate(fn, arg),
        screenshot: ({ full }) => page.screenshot({ fullPage: !!full, type: 'png' }),
        close: async () => {
          await ctx.close().catch(() => {});
          // Keep the browser warm for a minute so follow-up screenshots are instant.
          idleTimer = setTimeout(async () => {
            const b = await pwBrowser;
            pwBrowser = null;
            b?.close().catch(() => {});
          }, 60000);
          idleTimer.unref?.();
        },
      };
    },
  };
}

// ───────── Public API ─────────

async function resolveTarget(target, root) {
  let t = String(target || '').trim();
  if (/^https?:\/\//i.test(t) || /^file:/i.test(t)) return t;
  if (/^localhost(:\d+)?/i.test(t)) return `http://${t}`;
  if (!t || t === 'preview') {
    for (const c of ['index.html', 'public/index.html', 'src/index.html', 'dist/index.html']) {
      if (fs.existsSync(path.join(root, c))) {
        t = c;
        break;
      }
    }
    if (!t) throw new Error('No index.html found. Pass a target: an .html file or a URL like http://localhost:5173');
  }
  const full = path.resolve(root, t);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Target is outside the workspace.');
  const st = await fsp.stat(full).catch(() => null);
  if (!st) throw new Error(`File not found: ${t}`);
  return pathToFileURL(st.isDirectory() ? path.join(full, 'index.html') : full).href;
}

async function runActions(session, actions, onStep) {
  const done = [];
  for (const a of actions) {
    if (a.type === 'wait') {
      await new Promise((r) => setTimeout(r, a.ms));
      done.push(`waited ${a.ms}ms`);
    } else if (a.type === 'unknown') {
      done.push(`skipped unknown step "${a.raw}"`);
    } else {
      try {
        done.push(await session.eval(PAGE_ACTION, a));
      } catch (e) {
        done.push(`FAILED: ${String(e.message || e).replace(/^.*Error:\s*/, '').slice(0, 120)}`);
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    await onStep?.();
  }
  return done;
}

function reportText(kind, url, size, r, steps, logs, failed, ms) {
  const issues = [];
  if (r.overflowX) issues.push(`horizontal overflow: page is ${r.overflowX}px wider than the screen (${r.overflow.join('; ') || 'unknown element'})`);
  if (r.brokenImages.length) issues.push(`broken images: ${r.brokenImages.join(', ')}`);
  if (r.empty) issues.push('the page looks empty (no visible text or media)');
  if (r.tinyText) issues.push(`${r.tinyText} elements with text smaller than 11px`);
  const errs = logs.filter((l) => l.type === 'error');
  if (errs.length) issues.push(`console errors: ${errs.slice(0, 5).map((l) => l.text.slice(0, 160)).join(' | ')}`);
  if (failed.length) issues.push(`failed requests: ${failed.slice(0, 5).join(', ')}`);
  return [
    `${kind} of ${url} at ${size[0]}×${size[1]} — "${r.title || 'untitled'}", page height ${r.pageHeight}px. Took ${(ms / 1000).toFixed(1)}s.`,
    ...(steps.length ? ['Actions:', ...steps.map((s, i) => `  ${i + 1}. ${s}`)] : []),
    issues.length ? `⚠ Issues found:\n${issues.map((i) => `  - ${i}`).join('\n')}` : '✓ No problems detected (no console errors, broken images or overflow).',
    `Interactive elements: ${r.controls.join(', ') || 'none'}`,
    `Visible text: ${r.text ? r.text.slice(0, 600).replace(/\n+/g, ' / ') : '(none)'}`,
  ].join('\n');
}

/** Screenshot a page (optionally after actions). */
export async function screenshot({ target, size = 'desktop', full = false, actions = '', root, provider }) {
  const t0 = performance.now();
  const url = await resolveTarget(target, root);
  const [w, h] = parseSize(size);
  const p = provider || chromeProvider();
  const s = await p.open({ width: w, height: h });
  try {
    await s.goto(url);
    const steps = await runActions(s, parseActions(actions));
    const report = await s.eval(PAGE_REPORT);
    const png = await s.screenshot({ full });
    // JPEG for the model (much smaller than PNG); cap very tall full-page shots.
    const jpg = await toJpeg(png, full ? 1400 : 1600);
    const ms = Math.round(performance.now() - t0);
    const text = reportText('Screenshot', url.replace(pathToFileURL(root).href + '/', ''), [w, h], report, steps, s.logs, s.failed, ms) + '\n(The screenshot is attached.)';
    return {
      text,
      images: [jpg.toString('base64')],
      ms,
      display: { type: 'media', kind: 'screenshot', name: target || 'index.html', ms, image: jpg.toString('base64'), report, steps, size: [w, h], logs: s.logs.slice(0, 10), failed: s.failed.slice(0, 10) },
    };
  } finally {
    await s.close();
  }
}

async function toJpeg(png, maxH) {
  const { stdout } = await ffmpeg(['-v', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-vf', `scale='min(1600,iw)':-2,crop=iw:'min(ih,${maxH * 3})':0:0`, '-q:v', '5', '-f', 'mjpeg', 'pipe:1'], { input: png });
  return stdout;
}

/** Record a video of the page while running actions, then watch it. */
export async function recordVideo({ target, size = 'desktop', actions = '', seconds = 4, root, provider, watch }) {
  const t0 = performance.now();
  const url = await resolveTarget(target, root);
  const [w, h] = parseSize(size);
  const p = provider || chromeProvider();
  const s = await p.open({ width: w, height: h });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'buddo-rec-'));
  const frames = [];
  let recording = true;
  let startAt = 0;
  let grabber = Promise.resolve();
  const startGrabbing = () => (startAt = performance.now(), grabber = (async () => {
    while (recording) {
      const t = performance.now();
      try {
        frames.push(await s.screenshot({ full: false }));
      } catch {}
      await new Promise((r) => setTimeout(r, Math.max(0, 100 - (performance.now() - t))));
    }
  })());
  try {
    await s.goto(url);
    startGrabbing();
    await new Promise((r) => setTimeout(r, 600));
    const steps = await runActions(s, parseActions(actions));
    await new Promise((r) => setTimeout(r, Math.min(30, Math.max(0, seconds ?? 4)) * 1000));
    recording = false;
    await grabber;
    const elapsed = (performance.now() - startAt) / 1000;
    const report = await s.eval(PAGE_REPORT);
    if (frames.length < 2) throw new Error('Could not capture frames from the page.');
    await Promise.all(frames.map((f, i) => fsp.writeFile(path.join(dir, `${String(i).padStart(5, '0')}.png`), f)));
    const outDir = path.join(root, '.buddo', 'recordings');
    await fsp.mkdir(outDir, { recursive: true });
    const base = (String(target || 'page').replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '-').replace(/\.html?$/, '') || 'page').slice(0, 40);
    const outFile = path.join(outDir, `${base}-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.mp4`);
    const fps = Math.max(1, Math.min(30, frames.length / elapsed));
    await ffmpeg(['-v', 'error', '-framerate', fps.toFixed(3), '-i', path.join(dir, '%05d.png'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outFile]);
    const rel = path.relative(root, outFile).split(path.sep).join('/');
    const seen = await watch(outFile, { frames: Math.min(12, Math.max(4, Math.round(elapsed * 1.5))), listen: false, detect: false });
    const ms = Math.round(performance.now() - t0);
    const text = [
      reportText('Recording', url.replace(pathToFileURL(root).href + '/', ''), [w, h], report, steps, s.logs, s.failed, ms),
      `Saved ${elapsed.toFixed(1)}s video (${frames.length} frames) to ${rel}.`,
      seen.text.split('\n').filter((l) => /^ {2}#|^Key frames|^Scene cuts/.test(l)).join('\n'),
    ].join('\n');
    return { text, images: seen.images, ms, display: { ...seen.display, kind: 'recording', name: rel, ms, report, steps, saved: rel } };
  } finally {
    recording = false;
    await s.close();
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const browserAvailable = (provider) => !!provider || !!findChrome();
