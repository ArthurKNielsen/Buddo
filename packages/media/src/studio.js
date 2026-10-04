// Make and edit videos, fully local.
//
//  makeVideo  → render an HTML page (UI elements, CSS/JS animations, canvas, SVG) frame by frame
//               into an mp4 / webm / gif. Time is virtual, so every frame is exact, however slow the machine.
//  editVideo  → cut, trim, join, speed up, crop for Shorts/Reels, add text, captions, music, logos
//               and animated HTML overlays (lower thirds, subscribe buttons…) with ffmpeg.
//               The recipe itself lives in @buddo/core (video-edit.js) so the website runs it on ffmpeg.wasm.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ffmpeg, probe, fmtTime } from './ffmpeg.js';
import { chromeProvider, resolveTarget } from './browser.js';
import { parseVideoSize, runEdit, videoSlug as slug, VIDEO_OUT } from '@buddo/core';

export { parseVideoSize };


// ───────── makeVideo: HTML → video ─────────

// Runs in the page before any of its scripts: a virtual clock. Timers, requestAnimationFrame,
// performance.now / Date, CSS animations & transitions, Web Animations and <video> elements all
// follow `__buddo.frame(ms)` instead of the wall clock, so rendering is frame-exact.
export const CLOCK = `(() => {
  if (window.__buddo) return;
  const realRaf = window.requestAnimationFrame.bind(window);
  const realTimeout = window.setTimeout.bind(window);
  const RealDate = Date;
  const base = performance.now();
  const dateBase = RealDate.now();
  let vt = 0;
  let seq = 0;
  const timers = new Map();
  let rafs = [];
  const started = new WeakMap();
  performance.now = () => base + vt;
  function FakeDate(...a) {
    if (!new.target) return new RealDate(dateBase + vt).toString();
    return a.length ? new RealDate(...a) : new RealDate(dateBase + vt);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => dateBase + vt;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;
  window.setTimeout = (fn, ms, ...args) => (timers.set(++seq, { at: vt + Math.max(0, +ms || 0), fn, args }), seq);
  window.setInterval = (fn, ms, ...args) => (timers.set(++seq, { at: vt + Math.max(1, +ms || 0), every: Math.max(1, +ms || 0), fn, args }), seq);
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  window.requestAnimationFrame = (fn) => (rafs.push({ id: ++seq, fn }), seq);
  window.cancelAnimationFrame = (id) => { rafs = rafs.filter((r) => r.id !== id); };
  const call = (fn, args) => { try { typeof fn === 'function' ? fn(...args) : (0, eval)(String(fn)); } catch (e) { console.error(e); } };
  const syncAnimations = () => {
    for (const a of document.getAnimations()) {
      if (!started.has(a)) started.set(a, vt);
      if (a.playState !== 'paused') a.pause();
      a.currentTime = (vt - started.get(a)) * (a.playbackRate || 1);
    }
  };
  window.__buddo = {
    async frame(t) {
      if (t === 0) {
        await document.fonts?.ready;
        await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r); realTimeout(r, 3000); })));
      }
      for (let guard = 0; guard < 5000; guard++) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= t && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        const [id, x] = next;
        vt = x.at;
        if (x.every) x.at += x.every;
        else timers.delete(id);
        call(x.fn, x.args);
      }
      vt = t;
      const due = rafs;
      rafs = [];
      for (const r of due) call(r.fn, [base + vt]);
      if (typeof window.renderFrame === 'function') {
        try { await window.renderFrame(vt / 1000); } catch (e) { console.error(e); }
      }
      syncAnimations();
      await Promise.all([...document.querySelectorAll('video')].map((v) => {
        v.muted = true;
        v.pause();
        const want = v.duration ? (v.loop ? (vt / 1000) % v.duration : Math.min(vt / 1000, v.duration)) : vt / 1000;
        if (Math.abs(v.currentTime - want) < 0.001) return null;
        return new Promise((r) => { v.addEventListener('seeked', r, { once: true }); realTimeout(r, 1000); v.currentTime = want; }).catch(() => {});
      }));
      await new Promise((r) => realRaf(() => r()));
    },
    /** Seconds until the last finite animation ends (0 if none). */
    duration() {
      let end = 0;
      for (const a of document.getAnimations()) {
        const ct = a.effect?.getComputedTiming?.();
        if (!ct || !Number.isFinite(ct.endTime)) continue;
        end = Math.max(end, (started.get(a) ?? 0) + ct.endTime / (a.playbackRate || 1));
      }
      for (const x of timers.values()) if (!x.every) end = Math.max(end, x.at);
      return end / 1000;
    },
  };
})();`;

const nativeSetTimeout = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Render frames of a page into `dir` (00000.jpg, 00001.jpg…, or .png when transparent).
 * Returns { frames, seconds, fps, size, logs, failed, autoLength }.
 */
export async function renderFrames({ url, size = '1080p', fps = 30, seconds, transparent = false, provider, dir, onProgress }) {
  const [w, h] = parseVideoSize(size);
  const p = provider || chromeProvider();
  const s = await p.open({ width: w, height: h, init: CLOCK, transparent });
  try {
    await s.goto(url);
    if (!(await s.eval(() => !!window.__buddo))) throw new Error('Could not take control of the page clock.');
    await s.eval((t) => window.__buddo.frame(t), 0);
    let len = Number(seconds);
    let autoLength = false;
    if (!(len > 0)) len = await s.eval(() => (typeof window.videoDuration === 'number' ? window.videoDuration : 0));
    if (!(len > 0)) {
      // Hold the last animated frame for half a second so the video doesn't end abruptly.
      const d = await s.eval(() => window.__buddo.duration());
      len = d > 0 ? d + 0.5 : 5;
      autoLength = true;
    }
    len = Math.min(120, Math.max(0.2, len));
    const total = Math.max(1, Math.round(len * fps));
    for (let i = 0; i < total; i++) {
      if (i > 0) await s.eval((t) => window.__buddo.frame(t), (i * 1000) / fps);
      const img = await s.screenshot({ full: false, transparent, format: transparent ? 'png' : 'jpeg' });
      await fsp.writeFile(path.join(dir, `${String(i).padStart(5, '0')}.${transparent ? 'png' : 'jpg'}`), img);
      onProgress?.({ stage: 'render', done: i + 1, total });
    }
    return { frames: total, seconds: total / fps, fps, size: [w, h], logs: s.logs, failed: s.failed, autoLength, pattern: path.join(dir, `%05d.${transparent ? 'png' : 'jpg'}`) };
  } finally {
    await s.close();
  }
}

function outPath(root, out, fallback) {
  const rel = String(out || '').trim() || fallback;
  const full = path.resolve(root, rel.replace(/^\/+/, ''));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Output path is outside the workspace.');
  return full;
}

function inside(root, p) {
  const full = path.resolve(root, String(p).trim().replace(/^\/+/, ''));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Path "${p}" is outside the workspace.`);
  if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
  return full;
}

const relTo = (root, p) => path.relative(root, p).split(path.sep).join('/');

/** Encode args for an output file, by extension. */
function encodeArgs(file, { alpha = false, audio = true } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.webm') {
    return ['-c:v', 'libvpx-vp9', '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-deadline', 'realtime', '-cpu-used', '8', ...(audio ? ['-c:a', 'libopus'] : ['-an'])];
  }
  if (ext === '.mov' && alpha) return ['-c:v', 'png', ...(audio ? ['-c:a', 'aac'] : ['-an'])];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']), '-movflags', '+faststart'];
}

/** mp4 → gif with a proper palette (small and sharp). */
async function toGif(src, gif) {
  await ffmpeg(['-v', 'error', '-i', src, '-vf', "fps=15,scale='min(640,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", '-y', gif]);
}

async function finish(tmpFile, out, args) {
  if (path.extname(out).toLowerCase() === '.gif') {
    await ffmpeg([...args, '-y', tmpFile]);
    await toGif(tmpFile, out);
  } else {
    await ffmpeg([...args, '-y', out]);
  }
}

/** Short report + key frames of a finished video. */
async function report(root, out, watch, extra, t0) {
  const meta = await probe(out);
  const rel = relTo(root, out);
  let seen = { text: '', images: [], display: { type: 'media', kind: 'video' } };
  if (watch && path.extname(out).toLowerCase() !== '.gif') {
    seen = await watch(out, { frames: Math.min(12, Math.max(4, Math.round(meta.duration * 1.5))), listen: false, detect: false });
  }
  const ms = Math.round(performance.now() - t0);
  const text = [
    ...extra,
    `Saved ${rel} — ${fmtTime(meta.duration)} long, ${meta.width}×${meta.height}, ${meta.audio ? 'with audio' : 'no audio'}, ${Math.max(1, Math.round((meta.size || 0) / 1024))} KB. Took ${(ms / 1000).toFixed(1)}s.`,
    ...seen.text.split('\n').filter((l) => /^ {2}#|^Key frames/.test(l)),
    seen.images.length ? 'Look at the key frames: if something looks wrong, fix it and render again.' : '',
  ].filter(Boolean);
  return { text: text.join('\n'), images: seen.images, ms, display: { ...seen.display, kind: 'made', name: rel, saved: rel, ms, meta } };
}

/**
 * Make a video from an HTML page. opts: { target, size, seconds, fps, audio, out, transparent, root, provider, watch }
 * The page can set `window.videoDuration = 8` (seconds) and/or define `window.renderFrame = (t) => …`
 * to draw frame t itself (canvas, charts…). CSS / JS animations just work.
 */
export async function makeVideo({ target, size = '1080p', seconds, fps = 30, audio, out, transparent = false, root, provider, watch, onProgress }) {
  const t0 = performance.now();
  const url = await resolveTarget(target, root);
  fps = Math.min(60, Math.max(1, Math.round(Number(fps) || 30)));
  let file = outPath(root, out, `videos/${slug(target || 'video')}.mp4`);
  if (!path.extname(file)) file += '.mp4';
  const ext = path.extname(file).toLowerCase();
  if (!VIDEO_OUT.includes(ext)) throw new Error('Output must be .mp4, .webm, .mov or .gif');
  const alpha = transparent && (ext === '.webm' || ext === '.mov');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'buddo-make-'));
  try {
    const r = await renderFrames({ url, size, fps, seconds, transparent: alpha, provider, dir, onProgress });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const args = ['-v', 'error', '-framerate', String(fps), '-i', r.pattern];
    const music = audio ? inside(root, audio) : null;
    if (music) {
      const fade = Math.min(1.5, r.seconds / 4);
      args.push('-stream_loop', '-1', '-i', music, '-filter_complex', `[1:a]atrim=0:${r.seconds},afade=t=out:st=${(r.seconds - fade).toFixed(3)}:d=${fade.toFixed(3)}[a]`, '-map', '0:v', '-map', '[a]');
    }
    args.push(...encodeArgs(file, { alpha, audio: !!music }), '-t', r.seconds.toFixed(3));
    await finish(path.join(dir, 'tmp.mp4'), file, args);
    const errs = r.logs.filter((l) => l.type === 'error');
    const extra = [
      `Rendered ${r.frames} frames of ${url.replace(/^file:\/\/.*\//, '')} at ${r.size[0]}×${r.size[1]}, ${fps} fps${r.autoLength ? ` (length ${r.seconds.toFixed(1)}s picked from the page's animations — set <seconds> or window.videoDuration to change it)` : ''}.`,
      errs.length ? `⚠ Console errors: ${errs.slice(0, 5).map((l) => l.text.slice(0, 160)).join(' | ')}` : '',
      r.failed.length ? `⚠ Failed requests: ${r.failed.slice(0, 5).join(', ')}` : '',
      transparent && !alpha ? '⚠ Transparency needs a .webm or .mov output; this file has a solid background.' : '',
    ];
    return await report(root, file, watch, extra, t0);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ───────── editVideo: the shared recipe (@buddo/core) on native ffmpeg ─────────

const FONTS = [
  process.env.BUDDO_FONT,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial Bold.ttf',
  'C:\\Windows\\Fonts\\arialbd.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
];
let fontFile;
const findFont = () => (fontFile ??= FONTS.find((f) => f && fs.existsSync(f)) || null);

/**
 * Edit videos. opts: { inputs: [paths] or text, steps (text, one per line), out, root, provider, watch, transcribe }
 * Several inputs are joined in order first (photos become still clips), then every step runs in order.
 */
export async function editVideo({ inputs, steps = '', out, root, provider, watch, transcribe, onProgress }) {
  const t0 = performance.now();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'buddo-edit-'));
  let overlays = 0;
  try {
    const r = await runEdit({ inputs, steps, out }, {
      input: async (f) => inside(root, f),
      probe,
      temp: (name) => path.join(dir, name),
      writeText: (p, text) => fsp.writeFile(p, text),
      ffmpeg: (args) => ffmpeg(args, { timeout: 1800000 }),
      finish: (args, file) => finish(path.join(dir, 'tmp.mp4'), file, args),
      encode: (file, o) => (o.quality === 'high' ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'] : encodeArgs(file, o)),
      font: findFont(),
      transcribe,
      output: async (target) => {
        const file = outPath(root, target);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        return file;
      },
      htmlOverlay: async (file, { W, H, fps, seconds }) => {
        const frames = path.join(dir, `overlay${overlays++}`);
        await fsp.mkdir(frames);
        const url = await resolveTarget(file, root);
        const r = await renderFrames({ url, size: `${W}x${H}`, fps, seconds, transparent: true, provider, dir: frames, onProgress });
        const errs = r.logs.filter((l) => l.type === 'error');
        return { pattern: r.pattern, seconds: r.seconds, notes: errs.length ? [`⚠ Console errors in ${file}: ${errs.slice(0, 3).map((l) => l.text.slice(0, 140)).join(' | ')}`] : [] };
      },
    });
    return await report(root, r.path, watch, r.notes, t0);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
