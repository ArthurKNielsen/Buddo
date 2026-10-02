// Thin async wrappers around ffmpeg / ffprobe (bundled via ffmpeg-static when available).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveBin(envName, pkg, fallback) {
  if (process.env[envName]) return process.env[envName];
  try {
    const p = require(pkg);
    const bin = typeof p === 'string' ? p : p?.path;
    if (bin) return bin.replace('app.asar', 'app.asar.unpacked');
  } catch {}
  return fallback;
}

export const FFMPEG = resolveBin('BUDDO_FFMPEG', 'ffmpeg-static', 'ffmpeg');
// ffprobe is optional: we can read everything we need from `ffmpeg -i` (saves ~100 MB in the desktop app).
export const FFPROBE = process.env.BUDDO_FFPROBE || null;

/** Run a binary; resolves { code, stdout (Buffer), stderr (string) }. */
export function run(bin, args, { input, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 2_000_000) err = err.slice(-1_000_000);
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`${bin} not found. Install ffmpeg (https://ffmpeg.org/download.html).`) : e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
    if (input) p.stdin.end(input);
  });
}

export async function ffmpeg(args, opts) {
  const r = await run(FFMPEG, ['-hide_banner', '-nostdin', ...args], opts);
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  return r;
}

/** Media info parsed from `ffmpeg -i` output. */
async function probeWithFfmpeg(file) {
  const r = await run(FFMPEG, ['-hide_banner', '-nostdin', '-i', file]);
  const err = r.stderr;
  if (!/Input #0/.test(err)) throw new Error(`Can't read media file: ${err.trim().split('\n').pop() || file}`);
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  const vLine = err.split('\n').find((l) => /Stream #\S+.*: Video: /.test(l) && !/attached pic/.test(l));
  const aLine = err.split('\n').find((l) => /Stream #\S+.*: Audio: /.test(l));
  let width;
  let height;
  if (vLine) {
    const m = /, (\d{2,5})x(\d{2,5})/.exec(vLine);
    if (m) [width, height] = [Number(m[1]), Number(m[2])];
  }
  const rot = /rotation of (-?[\d.]+) degrees/.exec(err);
  if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width];
  const fps = vLine && /, ([\d.]+) fps/.exec(vLine);
  const fmt = /Input #0, ([^,]+)/.exec(err);
  let size = 0;
  try {
    size = (await import('node:fs')).statSync(file).size;
  } catch {}
  return {
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    width,
    height,
    fps: fps ? Number(fps[1]) : 0,
    video: !!vLine,
    audio: !!aLine,
    videoCodec: vLine && /Video: (\w+)/.exec(vLine)?.[1],
    audioCodec: aLine && /Audio: (\w+)/.exec(aLine)?.[1],
    format: fmt?.[1],
    size,
  };
}

export async function probe(file) {
  if (!FFPROBE) return probeWithFfmpeg(file);
  const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new Error(`Can't read media file: ${r.stderr.trim().split('\n').pop() || file}`);
  const j = JSON.parse(r.stdout.toString());
  const v = j.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const rot = Number(v?.tags?.rotate || v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0);
  let width = v?.width;
  let height = v?.height;
  if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [width, height] = [height, width];
  const [n, d] = (v?.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    duration: Number(j.format.duration) || Number(v?.duration) || Number(a?.duration) || 0,
    width,
    height,
    fps: d ? Math.round((n / d) * 100) / 100 : 0,
    video: !!v,
    audio: !!a,
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    format: j.format.format_name,
    size: Number(j.format.size) || 0,
  };
}

export const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};
