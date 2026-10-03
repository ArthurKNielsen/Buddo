// @buddo/media — lets the agent watch videos, hear audio and look at images, fast and fully local.
//
//  watchVideo(file)  → scene cuts, timestamped key frames (one contact-sheet image for the model),
//                      objects per frame, transcript with timestamps, sounds, loudness
//  listenAudio(file) → transcript with timestamps, sounds over time, loudness, silences
//  viewImage(file)   → resized image for vision models + detected objects with positions

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ffmpeg, probe, fmtTime, FFMPEG } from './ffmpeg.js';
import { decodeAudio, hear, preloadHearing } from './hearing.js';
import { detect as detectObjects, summarizeObjects, preloadVision, SIZE } from './vision.js';
import { status, ensureAll, ensureModel, MODELS } from './models.js';

export { status as modelStatus, ensureAll, ensureModel, MODELS, probe, FFMPEG };
import { screenshot as shot, recordVideo as rec, browserAvailable, chromeProvider, parseActions } from './browser.js';
export { browserAvailable, chromeProvider, parseActions };
import { makeVideo as make, editVideo as edit } from './studio.js';
import { transcribe } from './hearing.js';
export { parseSteps, parseVideoSize, captionChunks, CLOCK } from './studio.js';

/** Screenshot a page Buddo built (or any URL). opts: { target, size, full, actions, root, provider } */
export const screenshot = (opts) => shot(opts);
/** Record a page while doing actions; saves an mp4 and returns its key frames. */
export const recordVideo = (opts) => rec({ ...opts, watch: (file, o) => watchVideo(file, o) });

/** Make a video from an HTML page (UI elements, animations), rendered frame by frame. */
export const makeVideo = (opts) => make({ ...opts, watch: (file, o) => watchVideo(file, o) });
/** Edit videos: trim, cut, join, speed, crop, text, captions, music, logos, HTML overlays. */
export const editVideo = (opts) =>
  edit({
    ...opts,
    watch: (file, o) => watchVideo(file, o),
    transcribe: async (file) => (await transcribe(await decodeAudio(file))).segments,
  });

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?|heic|avif)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|aiff?)$/i;
export const kindOf = (file) => (IMAGE_EXT.test(file) ? 'image' : AUDIO_EXT.test(file) ? 'audio' : 'video');

const cache = new Map();
async function cached(file, key, fn) {
  const st = await fs.stat(file);
  const k = `${file}|${st.mtimeMs}|${key}`;
  if (!cache.has(k)) {
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    cache.set(k, fn().catch((e) => {
      cache.delete(k);
      throw e;
    }));
  }
  return cache.get(k);
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'buddo-'));
}

const letterbox = `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease,pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x727272`;

/** One decode → a JPEG thumbnail (file) + a 640×640 RGB buffer for detection (stdout). */
async function grab(file, t, jpgPath, { thumbW, image = false } = {}) {
  const args = ['-v', 'error', '-skip_loop_filter', 'all', '-flags2', 'fast'];
  if (!image) args.push('-ss', t.toFixed(3));
  args.push('-i', file, '-frames:v', '1', '-filter_complex', `[0:v]split=2[a][b];[a]scale='min(${thumbW},iw)':-2[j];[b]${letterbox}[r]`);
  args.push('-map', '[j]', '-frames:v', '1', '-q:v', '4', '-y', jpgPath);
  args.push('-map', '[r]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  const { stdout } = await ffmpeg(args);
  if (stdout.length < SIZE * SIZE * 3) throw new Error(`Couldn't read a frame at ${fmtTime(t)}`);
  return stdout;
}

async function sceneCuts(file, duration, { start = 0, end } = {}) {
  const args = ['-v', 'info', '-skip_loop_filter', 'all', '-flags2', 'fast'];
  const long = (end ?? duration) - start > 180;
  if (long) args.push('-skip_frame', 'nokey');
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', file);
  if (end) args.push('-t', String(end - start));
  args.push('-an', '-sn', '-vf', `${long ? '' : 'fps=8,'}scale=160:-2,select='gt(scene,0.32)',showinfo`, '-f', 'null', '-');
  try {
    const { stderr } = await ffmpeg(args);
    return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => start + Number(m[1])).filter((t) => t > start + 0.2);
  } catch {
    return [];
  }
}

function pickTimes(duration, cuts, count, start, end) {
  const s = start;
  const e = Math.max(s + 0.1, Math.min(end ?? duration, duration) - 0.05);
  const span = e - s;
  const n = Math.max(1, Math.min(count, Math.ceil(span / 0.4)));
  const minGap = span / (n * 2);
  const times = [];
  // Shots matter most: one frame just after every scene cut, then fill evenly.
  for (const c of cuts) if (times.length < n && c + 0.15 < e) times.push(c + 0.15);
  for (let i = 0; times.length < n && i < n * 4; i++) {
    const t = s + (span * (i % n + 0.5)) / n + (i >= n ? span / (n * 4) : 0);
    if (!times.some((x) => Math.abs(x - t) < minGap)) times.push(t);
  }
  return times.sort((a, b) => a - b).slice(0, n);
}

/** Decode keyframes only, once: pick ~evenly spaced frames plus scene cuts; emit JPEG thumbs + 640² RGB. */
async function keyframePass(file, { start, end, step, thumbW, dir, meta }) {
  const args = ['-v', 'info', '-skip_frame', 'nokey', '-skip_loop_filter', 'all', '-flags2', 'fast'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', file);
  if (end) args.push('-t', String(end - start));
  const pick = `select='gt(scene\\,0.32)+if(gte(t\\,ld(1))\\,st(1\\,t+${step.toFixed(3)})+1\\,0)',metadata=mode=print`;
  args.push(
    '-an', '-sn', '-filter_complex', `[0:v]${pick},split=2[a][b];[a]scale='min(${thumbW},iw)':-2[j];[b]${letterbox}[r]`,
    '-map', '[j]', '-fps_mode', 'passthrough', '-q:v', '4', '-y', path.join(dir, 'k%03d.jpg'),
    '-map', '[r]', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  );
  const { stdout, stderr } = await ffmpeg(args);
  const metas = [...stderr.matchAll(/frame:\d+\s+pts:\d+\s+pts_time:([\d.]+)\s*\n(?:.*lavfi\.scene_score=([\d.]+))?/g)];
  const bytes = SIZE * SIZE * 3;
  const count = Math.min(metas.length, Math.floor(stdout.length / bytes));
  const frames = [];
  const cuts = [];
  for (let i = 0; i < count; i++) {
    const t = start + Number(metas[i][1]);
    const score = Number(metas[i][2] || 0);
    if (score > 0.32 && t > start + 0.2) cuts.push(t);
    frames.push({ t, jpg: path.join(dir, `k${String(i + 1).padStart(3, '0')}.jpg`), rgb: stdout.subarray(i * bytes, (i + 1) * bytes) });
  }
  return { frames, cuts };
}

async function contactSheet(frames, outPath, portrait) {
  const cols = frames.length <= 4 ? frames.length : portrait ? (frames.length > 8 ? 6 : 4) : frames.length > 9 ? 4 : 3;
  const rows = Math.ceil(frames.length / cols);
  const tileW = Math.floor((portrait ? 1200 : 1280) / cols / 2) * 2;
  const inputs = [];
  const filters = [];
  frames.forEach((f, i) => {
    inputs.push('-i', f.jpg);
    filters.push(`[${i}:v]scale=${tileW}:-2,setsar=1,pad=iw+6:ih+6:3:3:color=black[t${i}]`);
  });
  const total = cols * rows;
  const { width: tw, height: th } = frames[0].thumbSize;
  const tileH = Math.round((th / tw) * tileW / 2) * 2 + 6;
  for (let i = frames.length; i < total; i++) {
    inputs.push('-f', 'lavfi', '-i', `color=black:s=${tileW + 6}x${tileH}:d=1`);
    filters.push(`[${i}:v]setsar=1[t${i}]`);
  }
  const layout = Array.from({ length: total }, (_, i) => `${(i % cols) === 0 ? '0' : Array.from({ length: i % cols }, () => 'w0').join('+')}_${Math.floor(i / cols) === 0 ? '0' : Array.from({ length: Math.floor(i / cols) }, () => 'h0').join('+')}`).join('|');
  const tiles = Array.from({ length: total }, (_, i) => `[t${i}]`).join('');
  filters.push(total === 1 ? `${tiles}null[out]` : `${tiles}xstack=inputs=${total}:layout=${layout}[out]`);
  await ffmpeg(['-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '5', '-y', outPath]);
  return { cols, rows };
}

const pct = (p) => `${Math.round(p * 100)}%`;
const range = (a, b) => `${fmtTime(a)}–${fmtTime(b)}`;

function describeHearing(h) {
  const lines = [];
  if (h.speech) {
    if (h.speech.segments.length) {
      lines.push(`Speech${h.speech.language ? ` (language: ${h.speech.language})` : ''}:`);
      for (const s of h.speech.segments) lines.push(`  [${range(s.start, s.end)}] "${s.text}"`);
    } else lines.push('Speech: none detected.');
  }
  if (h.sounds) {
    if (h.sounds.overall.length) lines.push(`Sounds overall: ${h.sounds.overall.slice(0, 6).map((s) => `${s.label} ${pct(s.prob)}`).join(', ')}`);
    const tl = h.sounds.timeline.filter((x) => x.end - x.start >= 0.5).slice(0, 25);
    if (tl.length) lines.push(`Sounds over time: ${tl.map((x) => `${x.label} ${range(x.start, x.end)}`).join('; ')}`);
  }
  const l = h.loudness;
  const bits = [`average ${l.avgDb} dB`];
  if (l.peaks.length) bits.push(`loudest at ${l.peaks.map((p) => fmtTime(p.t)).join(', ')}`);
  if (l.silences.length) bits.push(`silent ${l.silences.slice(0, 5).map((s) => range(s.start, s.end)).join(', ')}`);
  lines.push(`Loudness: ${bits.join('; ')}`);
  return lines;
}

/**
 * Watch a video. Options: { start, end, frames (default 12), listen (default true), onProgress }
 * Returns { text, images: [base64 jpeg], display, ms }.
 */
export function watchVideo(file, opts = {}) {
  const { start = 0, end, frames: count = 12, listen = true, detect: findObjects = true, onProgress } = opts;
  const detect = findObjects ? detectObjects : async () => [];
  return cached(file, `watch:${start}:${end}:${count}:${listen}:${findObjects}`, async () => {
    const t0 = performance.now();
    const mark = (label) => process.env.BUDDO_MEDIA_DEBUG && console.error(`  [watch] ${label} @${Math.round(performance.now() - t0)}ms`);
    const meta = await probe(file);
    mark('probe');
    if (!meta.video) return listenAudio(file, opts);
    const e = Math.min(end ?? meta.duration, meta.duration || end || 0);
    const dir = await tmpDir();
    try {
      const portrait = meta.height > meta.width;
      const thumbW = portrait ? 360 : 480;
      const audioJob = listen && meta.audio ? decodeAudio(file, { start, end: e }).then((s) => hear(s, { offset: start, onProgress })).then((h) => (mark('audio done'), h)) : Promise.resolve(null);
      const n = Math.max(2, Math.min(32, count));
      const frames = [];
      let cuts = [];
      const span = e - start;
      if (span <= 1800) {
        // Fast path: ONE decode of keyframes only → scene cuts + evenly spaced frames (+ every cut),
        // written as thumbnails and as detector input in the same pass.
        const pass = await keyframePass(file, { start, end: e, step: (span / n) * 0.92, thumbW, dir, meta });
        mark('keyframe pass');
        cuts = pass.cuts;
        for (const f of pass.frames) frames.push({ t: f.t, jpg: f.jpg, objects: await detect(f.rgb, meta, { threshold: 0.4, onProgress }) });
        mark('detection');
      }
      // Sparse keyframes (screen recordings) or very long videos: seek to evenly spaced times instead.
      if (frames.length < Math.min(n, 4)) {
        const queue = pickTimes(meta.duration, [], n, start, e).filter((t) => !frames.some((f) => Math.abs(f.t - t) < span / (n * 2)));
        let id = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, queue.length) }, async () => {
            for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
              const jpg = path.join(dir, `s${String(id++).padStart(3, '0')}.jpg`);
              const rgb = await grab(file, t, jpg, { thumbW });
              frames.push({ t, jpg, objects: await detect(rgb, meta, { threshold: 0.4, onProgress }) });
            }
          }),
        );
        mark('seek frames');
      }
      frames.sort((a, b) => a.t - b.t);
      for (const f of frames) f.thumbSize = { width: thumbW, height: Math.round((meta.height / meta.width) * thumbW) };
      const sheetPath = path.join(dir, 'sheet.jpg');
      const grid = await contactSheet(frames, sheetPath, portrait);
      mark('contact sheet');
      const [sheet, hearing] = await Promise.all([fs.readFile(sheetPath), audioJob]);
      mark('hearing');
      const ms = Math.round(performance.now() - t0);

      const lines = [
        `VIDEO ${path.basename(file)} — ${fmtTime(meta.duration)} long, ${meta.width}×${meta.height} (${portrait ? 'vertical' : 'horizontal'}), ${meta.fps} fps, ${meta.audio ? 'has audio' : 'no audio'}. Watched ${start || e < meta.duration ? range(start, e) : 'all of it'} in ${(ms / 1000).toFixed(1)}s.`,
        `Scene cuts: ${cuts.length ? cuts.slice(0, 30).map(fmtTime).join(', ') : 'none (one continuous shot)'}`,
        `Key frames (attached as one contact sheet, ${grid.cols}×${grid.rows}, read left→right, top→bottom)${findObjects ? " with detected objects" : ""}:`,
        ...frames.map((f, i) => `  #${i + 1} ${fmtTime(f.t)}${findObjects ? ` — ${summarizeObjects(f.objects)}` : ''}`),
        ...(hearing ? describeHearing(hearing) : []),
      ];
      return {
        text: lines.join('\n'),
        images: [sheet.toString('base64')],
        ms,
        display: {
          type: 'media',
          kind: 'video',
          name: path.basename(file),
          meta,
          ms,
          cuts,
          sheet: sheet.toString('base64'),
          frames: frames.map((f) => ({ t: f.t, objects: findObjects ? summarizeObjects(f.objects) : '' })),
          hearing,
        },
      };
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/** Listen to an audio (or video) file. Options: { start, end, onProgress } */
export function listenAudio(file, opts = {}) {
  const { start = 0, end, onProgress } = opts;
  return cached(file, `listen:${start}:${end}`, async () => {
    const t0 = performance.now();
    const meta = await probe(file);
    if (!meta.audio) throw new Error(`${path.basename(file)} has no audio track.`);
    const e = Math.min(end ?? meta.duration, meta.duration || end || 0);
    const samples = await decodeAudio(file, { start, end: e });
    const hearing = await hear(samples, { offset: start, onProgress });
    const ms = Math.round(performance.now() - t0);
    const lines = [
      `AUDIO ${path.basename(file)} — ${fmtTime(meta.duration)} long (${meta.audioCodec}). Listened to ${start || e < meta.duration ? range(start, e) : 'all of it'} in ${(ms / 1000).toFixed(1)}s.`,
      ...describeHearing(hearing),
    ];
    return { text: lines.join('\n'), images: [], ms, display: { type: 'media', kind: 'audio', name: path.basename(file), meta, ms, hearing } };
  });
}

/** Look at an image. Returns a resized JPEG for vision models plus detected objects. */
export function viewImage(file, opts = {}) {
  return cached(file, 'view', async () => {
    const t0 = performance.now();
    const meta = await probe(file);
    const dir = await tmpDir();
    try {
      const jpg = path.join(dir, 'view.jpg');
      const rgb = await grab(file, 0, jpg, { thumbW: 1024, image: true });
      const objects = await detectObjects(rgb, meta, { threshold: 0.3, onProgress: opts.onProgress });
      const img = await fs.readFile(jpg);
      const ms = Math.round(performance.now() - t0);
      const lines = [
        `IMAGE ${path.basename(file)} — ${meta.width}×${meta.height}${meta.size ? `, ${Math.round(meta.size / 1024)} KB` : ''}. Looked in ${(ms / 1000).toFixed(1)}s.`,
        `Detected objects: ${summarizeObjects(objects)}`,
        ...objects.slice(0, 20).map((o) => `  - ${o.label} ${pct(o.score)} at ${o.where}`),
        '(The image itself is attached.)',
      ];
      return {
        text: lines.join('\n'),
        images: [img.toString('base64')],
        ms,
        display: { type: 'media', kind: 'image', name: path.basename(file), meta, ms, image: img.toString('base64'), objects },
      };
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/** Pick the right sense for a file. */
export function perceive(file, opts) {
  const k = kindOf(file);
  return k === 'image' ? viewImage(file, opts) : k === 'audio' ? listenAudio(file, opts) : watchVideo(file, opts);
}

/** Warm up models so the first look/listen is instant. */
export async function preload(onProgress) {
  await Promise.all([preloadHearing(onProgress), preloadVision(onProgress)]);
}
