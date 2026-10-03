// Make and edit videos, fully local.
//
//  makeVideo  → render an HTML page (UI elements, CSS/JS animations, canvas, SVG) frame by frame
//               into an mp4 / webm / gif. Time is virtual, so every frame is exact, however slow the machine.
//  editVideo  → cut, trim, join, speed up, crop for Shorts/Reels, add text, captions, music, logos
//               and animated HTML overlays (lower thirds, subscribe buttons…) with ffmpeg.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ffmpeg, probe, fmtTime } from './ffmpeg.js';
import { chromeProvider, parseSize, resolveTarget } from './browser.js';

export const VIDEO_SIZES = {
  '1080p': [1920, 1080], hd: [1920, 1080], wide: [1920, 1080], landscape: [1920, 1080], youtube: [1920, 1080],
  '720p': [1280, 720],
  vertical: [1080, 1920], portrait: [1080, 1920], short: [1080, 1920], shorts: [1080, 1920], reel: [1080, 1920], tiktok: [1080, 1920], story: [1080, 1920],
  square: [1080, 1080], instagram: [1080, 1080],
};

export function parseVideoSize(size = '1080p') {
  const s = String(size || '1080p').trim().toLowerCase();
  const [w, h] = VIDEO_SIZES[s] || parseSize(s);
  return [w - (w % 2), h - (h % 2)];
}

/** "1:23.5" | "83.5" | "83.5s" → seconds; "end" → Infinity. */
export function parseSeconds(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'end') return Infinity;
  const parts = s.replace(/s$/, '').split(':').map(Number);
  if (parts.some((x) => Number.isNaN(x))) return undefined;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

const RANGE = /(?:^|\s)(\d[\d:.]*s?)\s*(?:-|–|\bto\b)\s*(\d[\d:.]*s?|end)(?=\s|$)/i;
/** First "0:05-0:20" / "1:02.5 to 1:04" / "3-end" in a step, as [start, end] seconds. */
const parseRange = (s) => {
  const m = RANGE.exec(String(s));
  return m ? [parseSeconds(m[1]), parseSeconds(m[2])] : null;
};

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i;
const HTML_EXT = /\.html?$/i;

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
const slug = (s) => (String(s).replace(/^https?:\/\//, '').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'video').slice(0, 40);

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
  if (!['.mp4', '.webm', '.mov', '.gif'].includes(ext)) throw new Error('Output must be .mp4, .webm, .mov or .gif');
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

// ───────── editVideo: ffmpeg recipes ─────────

/** Parse one edit step per line. Unknown steps throw so the model can fix them. */
export function parseSteps(text = '') {
  return String(text)
    .split('\n')
    .map((l) => l.trim().replace(/^[-*\d.)\s]+(?=[a-z])/i, ''))
    .filter((l) => l && !l.startsWith('#'))
    .slice(0, 60)
    .map((line) => {
      const quoted = /"([^"]*)"|“([^”]*)”|'([^']*)'/.exec(line);
      const text = quoted ? quoted[1] ?? quoted[2] ?? quoted[3] : null;
      const rest = quoted ? (line.slice(0, quoted.index) + ' ' + line.slice(quoted.index + quoted[0].length)).trim() : line;
      const [verb, ...words] = rest.split(/\s+/);
      const v = verb.toLowerCase();
      const arg = words.join(' ');
      const range = parseRange(arg);
      const num = (re, d) => {
        const m = re.exec(arg);
        return m ? Number(m[1]) : d;
      };
      switch (v) {
        case 'trim':
        case 'keep': {
          if (!range) throw new Error(`"${line}": write trim START-END, e.g. trim 0:05-0:20`);
          return { type: 'trim', range };
        }
        case 'cut':
        case 'remove':
        case 'delete': {
          if (!range) throw new Error(`"${line}": write cut START-END, e.g. cut 0:03-0:04.5`);
          return { type: 'cut', range };
        }
        case 'speed': {
          const x = parseFloat(arg.replace(/x$/i, ''));
          if (!(x > 0)) throw new Error(`"${line}": write speed 2 (or 0.5 for slow motion)`);
          return { type: 'speed', x: Math.min(8, Math.max(0.125, x)), range };
        }
        case 'crop':
        case 'fit':
        case 'resize': {
          const size = words[0] || 'vertical';
          return { type: v === 'crop' ? 'crop' : 'fit', size: parseVideoSize(size), name: size };
        }
        case 'rotate': {
          const deg = ((parseInt(arg, 10) || 90) % 360 + 360) % 360;
          return { type: 'rotate', deg };
        }
        case 'flip':
          return { type: 'flip', vertical: /vert|v\b/i.test(arg) };
        case 'text':
        case 'title':
        case 'caption': {
          if (text === null && !arg) throw new Error(`"${line}": write text "Your words" [top|center|bottom] [0:01-0:03]`);
          return {
            type: 'text',
            text: text ?? arg,
            at: /\b(top|center|middle|bottom)\b/i.exec(rest)?.[1].toLowerCase() || (v === 'title' ? 'center' : 'bottom'),
            range,
            size: num(/\bsize\s+(\d+)/i),
            color: /\bcolor\s+(#?[\w]+)/i.exec(rest)?.[1] || 'white',
            box: /\bbox\b/i.test(rest),
          };
        }
        case 'captions':
        case 'subtitles':
          return { type: 'captions', at: /\b(top|center|middle)\b/i.exec(arg)?.[1].toLowerCase() || 'bottom' };
        case 'fade': {
          const dir = /\bout\b/i.test(arg) ? 'out' : /\bin\b/i.test(arg) ? 'in' : 'both';
          return { type: 'fade', dir, d: num(/([\d.]+)\s*s?\s*$/, 0.6) };
        }
        case 'music':
        case 'audio':
        case 'song': {
          const file = words.find((w) => /\.\w{2,4}$/.test(w));
          if (!file) throw new Error(`"${line}": write music song.mp3 [volume 0.3]`);
          return { type: 'music', file, volume: num(/\bvolume\s+([\d.]+)/i, 0.35), replace: /\breplace\b/i.test(arg) };
        }
        case 'volume':
          return { type: 'volume', x: Math.min(5, Math.max(0, parseFloat(arg) || 1)) };
        case 'mute':
          return { type: 'volume', x: 0 };
        case 'overlay':
        case 'logo':
        case 'image':
        case 'watermark': {
          const file = words.find((w) => /\.\w{2,5}$/.test(w));
          if (!file) throw new Error(`"${line}": write overlay logo.png [top-right] [size 15%] [0:02-0:06], or overlay lower-third.html [0:02-0:07]`);
          return {
            type: 'overlay',
            file,
            pos: /\b(top-left|top-right|bottom-left|bottom-right|top|bottom|center)\b/i.exec(arg)?.[1].toLowerCase() || (v === 'logo' || v === 'watermark' ? 'top-right' : 'center'),
            scale: num(/\bsize\s+([\d.]+)\s*%/i, v === 'logo' || v === 'watermark' ? 15 : 0) / 100,
            range,
            opacity: num(/\bopacity\s+([\d.]+)/i, v === 'watermark' ? 0.6 : 1),
          };
        }
        case 'color':
        case 'filter':
        case 'look': {
          const look = arg.toLowerCase().trim();
          if (!LOOKS[look]) throw new Error(`"${line}": looks are ${Object.keys(LOOKS).join(', ')}`);
          return { type: 'look', look };
        }
        case 'stills':
        case 'photos':
          return { type: 'stills', seconds: Math.min(60, Math.max(0.2, parseFloat(arg) || 3)) };
        default:
          throw new Error(`Unknown step "${line}". Steps: trim, cut, speed, crop, fit, rotate, flip, text, title, captions, fade, music, volume, mute, overlay, logo, color, stills.`);
      }
    });
}

const LOOKS = {
  bw: 'hue=s=0',
  'black and white': 'hue=s=0',
  grayscale: 'hue=s=0',
  vivid: 'eq=saturation=1.45:contrast=1.08',
  warm: 'colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.06:bm=-0.06',
  cool: 'colorbalance=rs=-0.06:bs=0.1:rm=-0.04:bm=0.08',
  bright: 'eq=brightness=0.07:contrast=1.05',
  dark: 'eq=brightness=-0.07:contrast=1.1',
  vintage: 'curves=preset=vintage',
  cinematic: 'eq=contrast=1.15:saturation=0.85,colorbalance=rs=-0.04:bs=0.06:rh=0.06:bh=-0.04',
};

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

/** Quote a path for use inside an ffmpeg filter graph. */
const fpath = (p) => `'${p.split(path.sep).join('/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;

const POS = {
  'top-left': ['m', 'm'],
  'top-right': ['W-w-m', 'm'],
  'bottom-left': ['m', 'H-h-m'],
  'bottom-right': ['W-w-m', 'H-h-m'],
  top: ['(W-w)/2', 'm'],
  bottom: ['(W-w)/2', 'H-h-m'],
  center: ['(W-w)/2', '(H-h)/2'],
};

function atempo(x) {
  const parts = [];
  while (x > 2) (parts.push(2), (x /= 2));
  while (x < 0.5) (parts.push(0.5), (x /= 0.5));
  parts.push(x);
  return parts.map((p) => `atempo=${p.toFixed(4)}`).join(',');
}

/** Wrap long lines so text never runs off a vertical video. */
function wrap(text, maxChars) {
  return text
    .split('\n')
    .map((para) => {
      const out = [];
      let line = '';
      for (const word of para.split(/\s+/)) {
        if (line && (line + ' ' + word).length > maxChars) (out.push(line), (line = word));
        else line = line ? `${line} ${word}` : word;
      }
      if (line) out.push(line);
      return out.join('\n');
    })
    .join('\n');
}

/** Split transcript segments into short caption chunks (Shorts / Reels style). */
export function captionChunks(segments, maxWords = 5) {
  const out = [];
  for (const s of segments) {
    const words = s.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const per = (s.end - s.start) / words.length;
    for (let i = 0; i < words.length; i += maxWords) {
      const n = Math.min(maxWords, words.length - i);
      out.push({ start: s.start + i * per, end: s.start + (i + n) * per, text: words.slice(i, i + n).join(' ') });
    }
  }
  return out;
}

/**
 * Edit videos. opts: { inputs: [paths], steps (text, one per line), out, root, provider, watch, transcribe }
 * Several inputs are joined in order first (photos become still clips), then every step runs in order.
 */
export async function editVideo({ inputs, steps = '', out, root, provider, watch, transcribe, onProgress }) {
  const t0 = performance.now();
  const list = (Array.isArray(inputs) ? inputs : String(inputs || '').split(/\n|,(?=\s*\S+\.\w+)/)).map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error('Give at least one input video (or photos).');
  const files = list.map((f) => inside(root, f));
  const ops = parseSteps(steps);
  const stills = ops.find((o) => o.type === 'stills')?.seconds ?? 3;
  let file = outPath(root, out, `videos/${slug(path.basename(files[0]))}-edit.mp4`);
  if (!path.extname(file)) file += '.mp4';
  if (!['.mp4', '.webm', '.mov', '.gif'].includes(path.extname(file).toLowerCase())) throw new Error('Output must be .mp4, .webm, .mov or .gif');
  if (files.includes(file)) throw new Error('Pick a different output file: it would overwrite an input.');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'buddo-edit-'));
  try {
    const metas = await Promise.all(files.map(async (f) => (IMAGE_EXT.test(f) ? { ...(await probe(f)), still: true, duration: stills, audio: false } : probe(f))));
    if (metas.every((m) => !m.video && !m.still)) throw new Error('No video in the inputs. To make a video from a web page use make_video; for photos list image files.');
    const first = metas.find((m) => m.video || m.still);
    let W = Math.min(3840, first.width || 1280);
    let H = Math.min(3840, first.height || 720);
    W -= W % 2;
    H -= H % 2;
    const FPS = 30;

    let args = ['-v', 'error'];
    let g = [];
    let n = 0;
    const label = (p) => `${p}${++n}`;
    let idx = 0;
    const addInput = (...a) => (args.push(...a), idx++);

    // 1. Inputs → same size, fps and audio format.
    const parts = [];
    files.forEach((f, i) => {
      const m = metas[i];
      const k = m.still ? addInput('-loop', '1', '-t', String(stills), '-i', f) : addInput('-i', f);
      const v = label('v');
      const a = label('a');
      if (m.video || m.still) g.push(`[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[${v}]`);
      else g.push(`color=black:s=${W}x${H}:r=${FPS}:d=${m.duration.toFixed(3)},format=yuv420p[${v}]`);
      if (m.audio) g.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo[${a}]`);
      else g.push(`anullsrc=r=48000:cl=stereo,atrim=0:${m.duration.toFixed(3)}[${a}]`);
      parts.push([v, a]);
    });
    let [V, A] = parts[0];
    let dur = metas.reduce((s, m) => s + (m.duration || 0), 0);
    if (parts.length > 1) {
      // Join in a pass of its own: ffmpeg stalls when a later trim stops reading a concat early.
      const joined = path.join(dir, 'joined.mp4');
      g.push(`${parts.map(([v, a]) => `[${v}][${a}]`).join('')}concat=n=${parts.length}:v=1:a=1[jv][ja]`);
      await ffmpeg([...args, '-filter_complex', g.join(';'), '-map', '[jv]', '-map', '[ja]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-c:a', 'aac', '-b:a', '192k', '-y', joined], { timeout: 1800000 });
      args = ['-v', 'error'];
      g = [];
      idx = 0;
      addInput('-i', joined);
      dur = (await probe(joined)).duration || dur;
      g.push('[0:v]null[jv]', '[0:a]anull[ja]');
      [V, A] = ['jv', 'ja'];
    }
    const vf = (f) => {
      const out = label('v');
      g.push(`[${V}]${f}[${out}]`);
      V = out;
    };
    const af = (f) => {
      const out = label('a');
      g.push(`[${A}]${f}[${out}]`);
      A = out;
    };
    const clampRange = ([a, b]) => [Math.max(0, Math.min(a, dur)), Math.max(0, Math.min(b, dur))];
    const font = findFont();
    const fontOpt = font ? `fontfile=${fpath(font)}` : 'font=Sans';
    let textId = 0;
    const drawText = (text, { at = 'bottom', range, size, color = 'white', box = false }) => {
      const px = size || Math.round(Math.min(W, H) / (at === 'center' ? 11 : 15));
      const tf = path.join(dir, `text${textId++}.txt`);
      fs.writeFileSync(tf, wrap(text, Math.max(8, Math.floor((W * 0.86) / (px * 0.58)))));
      const y = at === 'top' ? 'h*0.08' : at === 'center' || at === 'middle' ? '(h-text_h)/2' : 'h-text_h-h*0.12';
      const style = box ? `box=1:boxcolor=black@0.55:boxborderw=${Math.round(px * 0.35)}` : `borderw=${Math.max(2, Math.round(px / 14))}:bordercolor=black@0.85:shadowx=0:shadowy=${Math.round(px / 16)}:shadowcolor=black@0.4`;
      const when = range ? `:enable='between(t,${range[0].toFixed(3)},${Math.min(range[1], 1e6).toFixed(3)})'` : '';
      return `drawtext=${fontOpt}:textfile=${fpath(tf)}:fontsize=${px}:fontcolor=${color}:line_spacing=${Math.round(px * 0.2)}:x=(w-text_w)/2:y=${y}:${style}${when}`;
    };
    let captions = null;
    const notes = [];

    // 2. Every step, in order.
    for (const op of ops) {
      switch (op.type) {
        case 'trim': {
          const [a, b] = clampRange(op.range);
          if (b <= a) throw new Error(`trim ${fmtTime(op.range[0])}-${fmtTime(op.range[1])} is empty — the video is only ${fmtTime(dur)} long at that point.`);
          vf(`trim=start=${a}:end=${b},setpts=PTS-STARTPTS`);
          af(`atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS`);
          dur = b - a;
          break;
        }
        case 'cut': {
          const [a, b] = clampRange(op.range);
          if (b <= a) break;
          vf(`select='not(between(t,${a},${b}))',setpts=N/FRAME_RATE/TB`);
          af(`aselect='not(between(t,${a},${b}))',asetpts=N/SR/TB`);
          dur -= b - a;
          break;
        }
        case 'speed': {
          vf(`setpts=PTS/${op.x}`);
          af(atempo(op.x));
          dur /= op.x;
          break;
        }
        case 'crop': {
          const [w, h] = op.size;
          vf(`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`);
          [W, H] = [w, h];
          break;
        }
        case 'fit': {
          const [w, h] = op.size;
          const [b, f, bb, ff, o] = [label('x'), label('x'), label('x'), label('x'), label('v')];
          g.push(`[${V}]split[${b}][${f}]`);
          g.push(`[${b}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:2,eq=brightness=-0.08[${bb}]`);
          g.push(`[${f}]scale=${w}:${h}:force_original_aspect_ratio=decrease[${ff}]`);
          g.push(`[${bb}][${ff}]overlay=(W-w)/2:(H-h)/2,setsar=1[${o}]`);
          V = o;
          [W, H] = [w, h];
          break;
        }
        case 'rotate': {
          if (op.deg === 90) vf('transpose=1');
          else if (op.deg === 270) vf('transpose=2');
          else if (op.deg === 180) vf('transpose=1,transpose=1');
          if (op.deg === 90 || op.deg === 270) [W, H] = [H, W];
          break;
        }
        case 'flip':
          vf(op.vertical ? 'vflip' : 'hflip');
          break;
        case 'text':
          vf(drawText(op.text, op));
          break;
        case 'captions':
          captions = op;
          break;
        case 'fade': {
          const d = Math.min(op.d, dur / 2);
          if (op.dir !== 'out') (vf(`fade=t=in:st=0:d=${d}`), af(`afade=t=in:st=0:d=${d}`));
          if (op.dir !== 'in') (vf(`fade=t=out:st=${(dur - d).toFixed(3)}:d=${d}`), af(`afade=t=out:st=${(dur - d).toFixed(3)}:d=${d}`));
          break;
        }
        case 'music': {
          const k = addInput('-stream_loop', '-1', '-i', inside(root, op.file));
          const m = label('m');
          const fade = Math.min(1.5, dur / 4);
          g.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${op.volume},atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=${(dur - fade).toFixed(3)}:d=${fade.toFixed(3)}[${m}]`);
          if (op.replace) A = m;
          else {
            const o = label('a');
            g.push(`[${A}][${m}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[${o}]`);
            A = o;
          }
          break;
        }
        case 'volume':
          af(`volume=${op.x}`);
          break;
        case 'look':
          vf(LOOKS[op.look]);
          break;
        case 'stills':
          break;
        case 'overlay': {
          const [a, b] = op.range ? clampRange(op.range) : [0, dur];
          let k;
          let still = false;
          if (HTML_EXT.test(op.file)) {
            // Animated UI overlay: render the page with a see-through background at the video's size.
            const frames = path.join(dir, `ov${idx}`);
            await fsp.mkdir(frames);
            const url = await resolveTarget(op.file, root);
            const r = await renderFrames({ url, size: `${W}x${H}`, fps: FPS, seconds: op.range ? b - a : undefined, transparent: true, provider, dir: frames, onProgress });
            k = addInput('-framerate', String(FPS), '-i', r.pattern);
            notes.push(`Rendered ${op.file} as a ${r.seconds.toFixed(1)}s transparent overlay.`);
            const errs = r.logs.filter((l) => l.type === 'error');
            if (errs.length) notes.push(`⚠ Console errors in ${op.file}: ${errs.slice(0, 3).map((l) => l.text.slice(0, 140)).join(' | ')}`);
          } else {
            still = IMAGE_EXT.test(op.file) && !/\.gif$/i.test(op.file);
            k = addInput('-i', inside(root, op.file));
          }
          const o = label('x');
          const chain = [`format=rgba`];
          if (op.scale) chain.push(`scale=${Math.round(W * op.scale)}:-2`);
          else if (!HTML_EXT.test(op.file)) chain.push(`scale='min(${W},iw)':'min(${H},ih)':force_original_aspect_ratio=decrease`);
          if (op.opacity < 1) chain.push(`colorchannelmixer=aa=${op.opacity}`);
          if (!still) chain.push(`setpts=PTS-STARTPTS+${a.toFixed(3)}/TB`);
          g.push(`[${k}:v]${chain.join(',')}[${o}]`);
          const [x, y] = POS[op.pos] || POS.center;
          const m = Math.round(Math.min(W, H) * 0.04);
          const out2 = label('v');
          g.push(`[${V}][${o}]overlay=x=${x.replace(/m/g, m)}:y=${y.replace(/m/g, m)}:eof_action=${still ? 'repeat' : 'pass'}:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})',format=yuv420p[${out2}]`);
          V = out2;
          break;
        }
      }
    }

    // 3. Render.
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const graph = path.join(dir, 'graph.txt');
    await fsp.writeFile(graph, g.join(';\n'));
    const mainOut = captions ? path.join(dir, 'main.mp4') : file;
    const enc = ['-filter_complex_script', graph, '-map', `[${V}]`, '-map', `[${A}]`, ...encodeArgs(captions ? mainOut : file, { audio: path.extname(file).toLowerCase() !== '.gif' }), '-t', Math.max(0.1, dur).toFixed(3)];
    if (captions) await ffmpeg([...args, ...enc, '-y', mainOut], { timeout: 1800000 });
    else await finish(path.join(dir, 'tmp.mp4'), file, [...args, ...enc]);

    // 4. Captions: listen to the edited video, then burn the words in.
    if (captions) {
      if (!transcribe) throw new Error('Captions need the speech model (Settings → Senses).');
      const segs = await transcribe(mainOut);
      const chunks = captionChunks(segs, H > W ? 4 : 7);
      notes.push(chunks.length ? `Captions: ${chunks.length} lines from ${segs.length} speech segments.` : '⚠ Captions: no speech found, so no captions were added.');
      if (chunks.length) {
        const filters = chunks.map((c) => drawText(c.text, { at: captions.at, range: [c.start, c.end], size: Math.round(Math.min(W, H) / 13) }));
        const script = path.join(dir, 'captions.txt');
        await fsp.writeFile(script, `[0:v]${filters.join(',\n')}[v]`);
        await finish(path.join(dir, 'tmp.mp4'), file, ['-v', 'error', '-i', mainOut, '-filter_complex_script', script, '-map', '[v]', '-map', '0:a?', ...encodeArgs(file)]);
      } else {
        await finish(path.join(dir, 'tmp.mp4'), file, ['-v', 'error', '-i', mainOut, '-c', 'copy']);
      }
    }
    const extra = [
      `Edited ${list.join(' + ')} → ${ops.length ? ops.map((o) => o.type).join(', ') : 'joined'}.`,
      ...notes,
    ];
    return await report(root, file, watch, extra, t0);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
