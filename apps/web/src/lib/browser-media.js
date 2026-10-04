// Video editing on the website: the same recipes as the desktop app (@buddo/core runEdit), run on
// ffmpeg.wasm inside the browser. Nothing is uploaded anywhere. Loaded only when a video tool runs.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { runEdit, parseProbe, fmtTime } from '@buddo/core';
import fontURL from '../assets/DejaVuSans-Bold.ttf?url';

const MAX_INPUT = 400 * 1024 * 1024; // the browser keeps every file in memory while editing
const FONT = '/fonts/DejaVuSans-Bold.ttf';

let ready = null;
let ff = null;
let logs = [];
// One job at a time: ffmpeg.wasm runs a single program on one in-memory file system.
let queue = Promise.resolve();
const exclusive = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

async function load() {
  ready ||= (async () => {
    const f = new FFmpeg();
    f.on('log', ({ message }) => {
      if (globalThis.BUDDO_FFMPEG_DEBUG) console.debug('[ffmpeg]', message);
      logs.push(message);
      if (logs.length > 4000) logs = logs.slice(-2000);
    });
    await f.load({ coreURL, wasmURL });
    for (const d of ['/in', '/tmp', '/out', '/fonts']) await f.createDir(d).catch(() => {});
    await f.writeFile(FONT, new Uint8Array(await (await fetch(fontURL)).arrayBuffer()));
    ff = f;
    return f;
  })().catch((e) => {
    ready = null;
    throw new Error(`Couldn't start the in-browser video editor (${e.message || e}).`);
  });
  return ready;
}

function reset() {
  try {
    ff?.terminate();
  } catch {}
  ff = null;
  ready = null;
}

/** Run ffmpeg; returns its log. Throws with the last error lines when it fails. */
async function exec(args) {
  logs = [];
  // Keep warnings: ffmpeg.wasm's exit code alone doesn't always say what went wrong.
  let code;
  try {
    code = await ff.exec(['-hide_banner', '-nostdin', ...args.map((x, i) => (x === 'error' && args[i - 1] === '-v' ? 'warning' : x))]);
  } catch (e) {
    // The WebAssembly program crashed (out of memory…): start a fresh one next time.
    reset();
    throw new Error(`The in-browser video editor crashed${e?.message ? ` (${e.message})` : ''} — the video may be too big or long for the browser. Try a shorter clip or the Buddo desktop app.`);
  }
  const out = logs.join('\n');
  if (code !== 0) throw new Error(`ffmpeg failed: ${logs.filter((l) => l.trim()).slice(-3).join(' | ') || `exit code ${code}`}`);
  return out;
}

async function probe(file) {
  logs = [];
  // ffmpeg.wasm keeps the log level of the previous run, so ask for the file info explicitly.
  await ff.exec(['-hide_banner', '-v', 'info', '-i', file]);
  return parseProbe(logs.join('\n'));
}

async function wipe() {
  for (const d of ['/in', '/tmp', '/out']) {
    for (const e of await ff.listDir(d).catch(() => [])) {
      if (!e.isDir) await ff.deleteFile(`${d}/${e.name}`).catch(() => {});
    }
  }
}

const extOf = (p) => (/\.[^./]+$/.exec(p)?.[0] || '').toLowerCase();
const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Copy a project file into ffmpeg's memory. */
function inputs(ws) {
  const seen = new Map();
  return async (file) => {
    if (seen.has(file)) return seen.get(file);
    if (!ws.readBinary) throw new Error('This workspace cannot hold video files.');
    const bytes = await ws.readBinary(file);
    if (bytes.length > MAX_INPUT) throw new Error(`${file} is ${Math.round(bytes.length / 1048576)} MB — too big to edit in the browser (max ${MAX_INPUT / 1048576} MB). Trim it first or use the Buddo desktop app.`);
    const name = `/in/${seen.size}${extOf(file)}`;
    // writeFile hands the buffer to ffmpeg's worker (the original becomes unusable), so send a copy.
    await ff.writeFile(name, bytes.slice());
    seen.set(file, name);
    return name;
  };
}

// ultrafast: single-threaded WebAssembly is ~5-10× slower than native ffmpeg.
function encode(file, { audio = true, quality } = {}) {
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', quality === 'high' ? '18' : '23', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']), '-movflags', '+faststart'];
}

async function finish(args, out) {
  if (extOf(out) !== '.gif') return exec([...args, '-y', out]);
  await exec([...args, '-y', '/tmp/gif.mp4']);
  return exec(['-i', '/tmp/gif.mp4', '-vf', "fps=12,scale='min(480,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", '-y', out]);
}

/** The loudest moment (momentary loudness peak) — usually the best part to put effects on. */
async function loudestMoment(file, meta) {
  if (!meta.audio || meta.duration < 2) return null;
  const log = await exec(['-v', 'info', '-i', file, '-vn', '-af', 'ebur128=framelog=info', '-f', 'null', '-']).catch(() => '');
  let best = null;
  for (const m of log.matchAll(/t:\s*([\d.]+)\s+TARGET:[^\n]*?M:\s*(-?[\d.]+)/g)) {
    const [t, loud] = [Number(m[1]), Number(m[2])];
    if (t > 0.8 && t < meta.duration - 0.3 && (!best || loud > best.loud)) best = { t: t - 0.2, loud };
  }
  return best && best.loud > -70 ? best.t : null;
}

/** Key frames of a video as one contact sheet (+ their times). */
async function contactSheet(file, meta, count = 8) {
  const n = Math.max(2, Math.min(count, Math.ceil(meta.duration / 0.4) || 2));
  const cols = n <= 4 ? n : 4;
  const rows = Math.ceil(n / cols);
  const step = meta.duration / n;
  // Sample a hair faster than needed so rounding never leaves the last tile empty (tile keeps the first n).
  const times = Array.from({ length: n }, (_, i) => step * (i + 0.5));
  const w = meta.height > meta.width ? 200 : 320;
  await exec(['-i', file, '-vf', `fps=1/${(step * 0.97).toFixed(4)}:start_time=${(step / 2).toFixed(4)},scale=${w}:-2,tile=${cols}x${rows}:padding=4:color=black`, '-frames:v', '1', '-q:v', '5', '-y', '/tmp/sheet.jpg']);
  return { sheet: b64(await ff.readFile('/tmp/sheet.jpg')), times, cols, rows };
}

/** edit_video on the website. */
export function editVideo(ws, { inputs: list, steps, out }) {
  return exclusive(async () => {
    const t0 = performance.now();
    await load();
    try {
      // VP9 crashes ffmpeg.wasm, so the website makes .mp4 and .gif only.
      if (/\.(webm|mov)\s*$/i.test(out || '')) throw new Error('On the website videos are saved as .mp4 (or .gif). Use an .mp4 output; the desktop app can also make .webm and .mov.');
      const r = await runEdit({ inputs: list, steps, out }, {
        input: inputs(ws),
        probe,
        temp: (name) => `/tmp/${name}`,
        writeText: (p, text) => ff.writeFile(p, text),
        ffmpeg: exec,
        finish,
        encode,
        font: FONT,
        maxSize: 1920,
        output: async (target) => `/out/result${extOf(target)}`,
      });
      const bytes = await ff.readFile(r.path);
      await ws.writeBinary(r.out, bytes);
      const meta = { ...(await probe(r.path)), size: bytes.length };
      const seen = extOf(r.out) === '.gif' ? null : await contactSheet(r.path, meta);
      const ms = Math.round(performance.now() - t0);
      const text = [
        ...r.notes,
        `Saved ${r.out} — ${fmtTime(meta.duration)} long, ${meta.width}×${meta.height}, ${meta.audio ? 'with audio' : 'no audio'}, ${Math.max(1, Math.round(bytes.length / 1024))} KB. Took ${(ms / 1000).toFixed(1)}s (in the browser).`,
        ...(seen ? [`Key frames (attached as one contact sheet, ${seen.cols}×${seen.rows}, read left→right, top→bottom):`, ...seen.times.map((t, i) => `  #${i + 1} ${fmtTime(t)}`), 'Look at the key frames: if something looks wrong, fix it and edit again.'] : []),
      ];
      return { text: text.join('\n'), images: seen ? [seen.sheet] : [], ms, display: { type: 'media', kind: 'made', name: r.out, saved: r.out, ms, meta, sheet: seen?.sheet } };
    } finally {
      if (ff) await wipe();
    }
  });
}

/** watch_video on the website: length, size and key frames (no hearing or object detection). */
export function watchVideo(ws, { path, frames = 8 }) {
  return exclusive(async () => {
    const t0 = performance.now();
    await load();
    try {
      const file = await inputs(ws)(path);
      const meta = await probe(file);
      if (!meta.video) throw new Error(`${path} has no video track. The website can't listen to audio; use the Buddo desktop app for that.`);
      const seen = await contactSheet(file, meta, Math.min(16, frames || 8));
      const loudest = await loudestMoment(file, meta);
      const ms = Math.round(performance.now() - t0);
      const text = [
        `VIDEO ${path} — ${fmtTime(meta.duration)} long, ${meta.width}×${meta.height} (${meta.height > meta.width ? 'vertical' : 'horizontal'}), ${meta.fps} fps, ${meta.audio ? 'has audio' : 'no audio'}.`,
        ...(loudest !== null ? [`Loudness: loudest at ${fmtTime(loudest)}`] : []),
        `Key frames (attached as one contact sheet, ${seen.cols}×${seen.rows}, read left→right, top→bottom):`,
        ...seen.times.map((t, i) => `  #${i + 1} ${fmtTime(t)}`),
        "(On the website Buddo sees the frames but can't hear the audio or detect objects. The desktop app can.)",
      ];
      return { text: text.join('\n'), images: [seen.sheet], ms, display: { type: 'media', kind: 'video', name: path, meta, ms, cuts: [], sheet: seen.sheet, frames: seen.times.map((t) => ({ t, objects: '' })) } };
    } finally {
      if (ff) await wipe();
    }
  });
}
