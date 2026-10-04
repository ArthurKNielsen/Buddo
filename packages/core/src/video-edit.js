// Video editing recipes shared by the desktop/CLI (native ffmpeg) and the website (ffmpeg.wasm).
// Pure: no Node or browser APIs. Everything that touches files or runs ffmpeg goes through `io`.

export const VIDEO_SIZES = {
  '1080p': [1920, 1080], hd: [1920, 1080], wide: [1920, 1080], landscape: [1920, 1080], youtube: [1920, 1080],
  '720p': [1280, 720],
  desktop: [1280, 800], mobile: [390, 844], phone: [390, 844], tablet: [820, 1180],
  vertical: [1080, 1920], portrait: [1080, 1920], short: [1080, 1920], shorts: [1080, 1920], reel: [1080, 1920], tiktok: [1080, 1920], story: [1080, 1920],
  square: [1080, 1080], instagram: [1080, 1080],
};

/** "vertical" | "720p" | "1280x720" → even [width, height]. */
export function parseVideoSize(size = '1080p') {
  const s = String(size || '1080p').trim().toLowerCase();
  const m = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(s);
  const [w, h] = VIDEO_SIZES[s] || (m ? [Math.min(3840, Number(m[1])), Math.min(3840, Number(m[2]))] : VIDEO_SIZES['1080p']);
  return [w - (w % 2), h - (h % 2)];
}

export const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};

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

export const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i;
export const HTML_EXT = /\.html?$/i;
export const VIDEO_OUT = ['.mp4', '.webm', '.mov', '.gif'];

export const LOOKS = {
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
          if (text === null && !arg) throw new Error(`"${line}": write text "Your words" [top|center|bottom] [0:01-0:03] [pop|slide|fade|type|none] [sound pop]`);
          const soundName = /\b(?:sound|sfx)\s+(\w+)/i.exec(rest)?.[1].toLowerCase();
          if (soundName && !SFX[soundName]) throw new Error(`"${line}": sounds are ${Object.keys(SFX).join(', ')}`);
          // Clean motion by default: titles pop in, other text slides up. "none" keeps it still.
          const anim = /\b(?:anim(?:ation)?\s+)?(pop|slide|rise|drop|fade|type|typewriter|none|static)\b/i.exec(rest.replace(/\b(?:sound|sfx)\s+\w+/i, ''))?.[1].toLowerCase();
          return {
            type: 'text',
            text: text ?? arg,
            at: /\b(top|center|middle|bottom)\b/i.exec(rest)?.[1].toLowerCase() || (v === 'title' ? 'center' : 'bottom'),
            range,
            size: num(/\bsize\s+(\d+)/i),
            color: /\bcolor\s+(#?[\w]+)/i.exec(rest)?.[1] || 'white',
            box: /\bbox\b/i.test(rest),
            anim: anim === 'typewriter' ? 'type' : anim === 'rise' ? 'slide' : anim === 'static' ? 'none' : anim || (v === 'title' ? 'pop' : 'slide'),
            sound: soundName,
          };
        }
        case 'sound':
        case 'sfx':
        case 'effect': {
          const name = words[0]?.toLowerCase();
          if (!SFX[name]) throw new Error(`"${line}": write sound pop 0:02 — sounds are ${Object.keys(SFX).join(', ')}`);
          const at = parseSeconds(/(?:^|\s)(?:at\s+)?(\d[\d:.]*s?)(?=\s|$)/i.exec(arg.replace(/\bvolume\s+[\d.]+/i, ''))?.[1]) ?? 0;
          return { type: 'sfx', name, at, volume: num(/\bvolume\s+([\d.]+)/i, 1) };
        }
        case 'zoom':
        case 'punch': {
          if (/\b(slow|kenburns|ken)\b/i.test(arg)) return { type: 'zoom', slow: true, amount: Math.min(1.5, Math.max(1.02, parseFloat(/\b(\d\.\d+)\b/.exec(arg)?.[1]) || 1.15)) };
          if (!range) throw new Error(`"${line}": write zoom 1.3 0:02-0:04 (punch in for a moment) or zoom slow (slow push-in)`);
          const amount = parseFloat(/^\s*(\d+(?:\.\d+)?)\s*x?\b(?!\s*[-–:])/.exec(arg)?.[1]);
          return { type: 'zoom', range, amount: Math.min(2.5, Math.max(1.02, amount > 0 ? amount : 1.25)) };
        }
        case 'shake': {
          if (!range) throw new Error(`"${line}": write shake 0:02-0:03`);
          return { type: 'shake', range, strength: Math.min(3, Math.max(0.2, num(/\b(?:strength|power)\s+([\d.]+)/i, 1))) };
        }
        case 'flash': {
          const at = parseSeconds(/(?:^|\s)(?:at\s+)?(\d[\d:.]*s?)(?=\s|$)/i.exec(arg)?.[1]);
          if (at === undefined) throw new Error(`"${line}": write flash 0:03`);
          return { type: 'flash', at };
        }
        case 'progress':
        case 'progressbar':
          return { type: 'progress', at: /\btop\b/i.test(arg) ? 'top' : 'bottom', color: /\bcolor\s+(#?[\w]+)/i.exec(arg)?.[1] || 'white' };
        case 'transition':
        case 'transitions': {
          const name = (words.find((w) => /^[a-z]+$/i.test(w) && !/^(sound|sfx|whoosh|swoosh|swipe|pop|ding|click|boom)$/i.test(w)) || 'fade').toLowerCase();
          if (!TRANSITIONS[name]) throw new Error(`"${line}": transitions are ${Object.keys(TRANSITIONS).join(', ')}`);
          const sound = /\b(whoosh|swoosh|swipe|pop|ding|click|boom)\b/i.exec(arg)?.[1].toLowerCase();
          return { type: 'transition', name, d: Math.min(2, Math.max(0.1, parseFloat(/\b(\d*\.?\d+)\s*s?\b/.exec(arg)?.[1]) || 0.5)), sound };
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
          throw new Error(`Unknown step "${line}". Steps: trim, cut, speed, crop, fit, rotate, flip, text, title, captions, fade, transition, zoom, shake, flash, progress, sound, music, volume, mute, overlay, logo, color, stills.`);
      }
    });
}

// Sound effects made from math (no files to download), so they work on the website too.
// Each is an ffmpeg audio source; `t` is seconds since the effect started.
export const SFX = {
  pop: ["aevalsrc='0.9*sin(2*PI*(380+2600*exp(-t*38))*t)*exp(-t*28)':s=48000:d=0.18"],
  click: ["aevalsrc='0.8*sin(2*PI*2200*t)*exp(-t*160)':s=48000:d=0.05"],
  ding: ["aevalsrc='0.45*sin(2*PI*1320*t)*exp(-t*4)+0.2*sin(2*PI*2640*t)*exp(-t*7)':s=48000:d=1.3"],
  success: ["aevalsrc='0.4*sin(2*PI*988*t)*exp(-t*6)*lt(t,0.14)+0.45*sin(2*PI*1319*(t-0.12))*exp(-(t-0.12)*4)*gte(t,0.12)':s=48000:d=1.2"],
  whoosh: ['anoisesrc=color=pink:r=48000:d=0.7:a=0.6', 'highpass=f=250', 'lowpass=f=4500', 'afade=t=in:d=0.35:curve=qsin', 'afade=t=out:st=0.35:d=0.35:curve=qsin', 'volume=2.5'],
  swipe: ['anoisesrc=color=pink:r=48000:d=0.3:a=0.5', 'highpass=f=600', 'lowpass=f=6000', 'afade=t=in:d=0.12', 'afade=t=out:st=0.12:d=0.18', 'volume=2.5'],
  boom: ["aevalsrc='0.95*sin(2*PI*(45+90*exp(-t*9))*t)*exp(-t*2.6)':s=48000:d=1.4"],
  rise: ["aevalsrc='0.35*sin(2*PI*(200*t+700*t*t))*min(1,t*2)':s=48000:d=1.2", 'afade=t=out:st=1:d=0.2'],
  beep: ["aevalsrc='0.4*sin(2*PI*1000*t)':s=48000:d=0.25", 'afade=t=out:st=0.18:d=0.07'],
};
SFX.swoosh = SFX.whoosh;
SFX.bass = SFX.boom;

const TRANSITIONS = {
  fade: 'fade', dissolve: 'dissolve', black: 'fadeblack', white: 'fadewhite',
  slide: 'slideleft', slideleft: 'slideleft', slideright: 'slideright', slideup: 'slideup', slidedown: 'slidedown',
  wipe: 'wipeleft', wipeleft: 'wipeleft', wiperight: 'wiperight', wipeup: 'wipeup', wipedown: 'wipedown',
  smooth: 'smoothleft', circle: 'circleopen', zoom: 'zoomin', blur: 'hblur', pixel: 'pixelize', radial: 'radial', squeeze: 'squeezeh',
};

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

/** Media info from `ffmpeg -i` stderr (works for native ffmpeg and ffmpeg.wasm). */
export function parseProbe(err, size = 0) {
  if (!/Input #0/.test(err)) throw new Error(`Can't read media file: ${err.trim().split('\n').pop() || 'unknown format'}`);
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

const ext = (p) => (/\.[^./\\]+$/.exec(p)?.[0] || '').toLowerCase();
const base = (p) => String(p).split(/[\\/]/).pop();
export const videoSlug = (s) => (String(s).replace(/^https?:\/\//, '').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'video').slice(0, 40);
const norm = (p) => String(p).trim().replace(/^\.?\/+/, '');

/** Quote a path for use inside an ffmpeg filter graph. */
export const filterPath = (p) => `'${String(p).replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;

/**
 * Edit videos: join the inputs (photos become still clips), then run every step in order.
 * `io` does the real work, so the same recipe runs on native ffmpeg and ffmpeg.wasm:
 *   input(file) → path ffmpeg can read · probe(path) → meta · temp(name) → scratch path
 *   writeText(path, text) · ffmpeg(args) · finish(args, out) (handles .gif) · encode(out, { audio }) → codec args
 *   font → font file path or null · htmlOverlay?(file, { W, H, fps, seconds }) → { pattern, seconds, notes }
 *   transcribe?(path) → speech segments · output(out) → path to write the result to
 * Returns { out, notes, ops }.
 */
export async function runEdit({ inputs, steps = '', out }, io) {
  const list = (Array.isArray(inputs) ? inputs : String(inputs || '').split(/\n|,(?=\s*\S+\.\w+)/)).map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error('Give at least one input video (or photos).');
  const ops = parseSteps(steps);
  const stills = ops.find((o) => o.type === 'stills')?.seconds ?? 3;
  let target = norm(out || '') || `videos/${videoSlug(base(list[0]))}-edit.mp4`;
  if (!ext(target)) target += '.mp4';
  if (!VIDEO_OUT.includes(ext(target))) throw new Error('Output must be .mp4, .webm, .mov or .gif');
  if (list.map(norm).includes(target)) throw new Error('Pick a different output file: it would overwrite an input.');

  const files = [];
  for (const f of list) files.push(await io.input(f));
  const metas = [];
  for (let i = 0; i < files.length; i++) {
    const m = await io.probe(files[i]);
    metas.push(IMAGE_EXT.test(list[i]) ? { ...m, still: true, duration: stills, audio: false } : m);
  }
  if (metas.every((m) => !m.video && !m.still)) throw new Error('No video in the inputs. To make a video from a web page use make_video; for photos list image files.');
  const first = metas.find((m) => m.video || m.still);
  // Keep the shape; shrink only past io.maxSize (the website keeps memory in check this way).
  const shrink = Math.min(1, (io.maxSize || 3840) / Math.max(first.width || 1280, first.height || 720));
  let W = Math.round((first.width || 1280) * shrink);
  let H = Math.round((first.height || 720) * shrink);
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
  const transition = files.length > 1 ? ops.find((o) => o.type === 'transition') : null;
  // Transitions overlap clips at exact times, so then every clip is cut (or padded) to its exact length.
  const exact = (d) => (transition ? `,tpad=stop_mode=clone:stop_duration=2,trim=duration=${d.toFixed(3)},setpts=PTS-STARTPTS` : '');
  const exactA = (d) => (transition ? `,apad,atrim=duration=${d.toFixed(3)},asetpts=PTS-STARTPTS` : '');
  files.forEach((f, i) => {
    const m = metas[i];
    const k = m.still ? addInput('-loop', '1', '-t', String(stills), '-i', f) : addInput('-i', f);
    const v = label('v');
    const a = label('a');
    if (m.video || m.still) g.push(`[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p${exact(m.duration)}[${v}]`);
    else g.push(`color=black:s=${W}x${H}:r=${FPS}:d=${m.duration.toFixed(3)},format=yuv420p[${v}]`);
    if (m.audio) g.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo${exactA(m.duration)}[${a}]`);
    else g.push(`anullsrc=r=48000:cl=stereo,atrim=0:${m.duration.toFixed(3)}[${a}]`);
    parts.push([v, a]);
  });
  let [V, A] = parts[0];
  let dur = metas.reduce((s, m) => s + (m.duration || 0), 0);
  const transitionTimes = [];
  if (parts.length > 1) {
    // Join in a pass of its own: ffmpeg stalls when a later trim stops reading a concat early.
    const joined = io.temp('joined.mp4');
    if (transition) {
      const T = Math.max(0.1, Math.min(transition.d, ...metas.map((m) => m.duration / 2 - 0.05)));
      let [cv, ca] = parts[0];
      let acc = metas[0].duration;
      for (let i = 1; i < parts.length; i++) {
        const [nv, na] = [label('v'), label('a')];
        const last = i === parts.length - 1;
        g.push(`[${cv}][${parts[i][0]}]xfade=transition=${TRANSITIONS[transition.name]}:duration=${T.toFixed(3)}:offset=${(acc - T).toFixed(3)}${last ? '[jv]' : `[${nv}]`}`);
        g.push(`[${ca}][${parts[i][1]}]acrossfade=d=${T.toFixed(3)}${last ? '[ja]' : `[${na}]`}`);
        transitionTimes.push(acc - T);
        acc += metas[i].duration - T;
        [cv, ca] = [nv, na];
      }
    } else g.push(`${parts.map(([v, a]) => `[${v}][${a}]`).join('')}concat=n=${parts.length}:v=1:a=1[jv][ja]`);
    await io.ffmpeg([...args, '-filter_complex', g.join(';'), '-map', '[jv]', '-map', '[ja]', ...io.encode('joined.mp4', { audio: true, quality: 'high' }), '-y', joined]);
    args = ['-v', 'error'];
    g = [];
    idx = 0;
    addInput('-i', joined);
    dur = (await io.probe(joined)).duration || dur;
    g.push('[0:v]null[jv]', '[0:a]anull[ja]');
    [V, A] = ['jv', 'ja'];
  }
  const vf = (f) => {
    const o = label('v');
    g.push(`[${V}]${f}[${o}]`);
    V = o;
  };
  const af = (f) => {
    const o = label('a');
    g.push(`[${A}]${f}[${o}]`);
    A = o;
  };
  const clampRange = ([a, b]) => [Math.max(0, Math.min(a, dur)), Math.max(0, Math.min(b, dur))];
  const fontOpt = io.font ? `fontfile=${filterPath(io.font)}` : 'font=Sans';
  let textId = 0;
  const n3 = (x) => Number(x.toFixed(3));
  const drawText = async (text, { at = 'bottom', range, size, color = 'white', box = false, anim = 'none' }) => {
    const px = size || Math.round(Math.min(W, H) / (at === 'center' ? 11 : 15));
    const lines = wrap(text, Math.max(8, Math.floor((W * 0.86) / (px * 0.58))));
    const a = n3(range ? range[0] : 0);
    const b = n3(range ? Math.min(range[1], 1e6) : 1e6);
    let y = at === 'top' ? 'h*0.08' : at === 'center' || at === 'middle' ? '(h-text_h)/2' : 'h-text_h-h*0.12';
    const style = box ? `box=1:boxcolor=black@0.55:boxborderw=${Math.round(px * 0.35)}` : `borderw=${Math.max(2, Math.round(px / 14))}:bordercolor=black@0.85:shadowx=0:shadowy=${Math.round(px / 16)}:shadowcolor=black@0.4`;
    const when = range ? `:enable='between(t,${a},${b})'` : '';
    // Clean motion: ease in, and fade out over the last quarter second when the text leaves before the end.
    const inTime = { pop: 0.12, slide: 0.3, drop: 0.3, fade: 0.45 }[anim];
    const out = range && b < dur - 0.05 ? `*clip((${b}-t)/0.25,0,1)` : '';
    const alpha = inTime ? `:alpha='clip((t-${a})/${inTime},0,1)${out}'` : out ? `:alpha='1${out}'` : '';
    let fontsize = String(px);
    const ease = (d) => `pow(1-clip((t-${a})/${d},0,1),3)`;
    if (anim === 'pop') fontsize = `'${px}*if(lt(t,${n3(a + 0.35)}),max(0.05,1+2.70158*pow((t-${a})/0.35-1,3)+1.70158*pow((t-${a})/0.35-1,2)),1)'`;
    if (anim === 'slide') y = `'${y}+h*0.05*${ease(0.45)}'`;
    if (anim === 'drop') y = `'${y}-h*0.05*${ease(0.45)}'`;
    const draw = async (shown, extra, x = '(w-text_w)/2') => {
      const tf = io.temp(`text${textId++}.txt`);
      await io.writeText(tf, shown);
      return `drawtext=${fontOpt}:textfile=${filterPath(tf)}:fontsize=${fontsize}:fontcolor=${color}:line_spacing=${Math.round(px * 0.2)}:x=${x}:y=${y}:${style}${extra}`;
    };
    if (anim !== 'type') return draw(lines, `${alpha}${when}`);
    // Typewriter: letters appear one by one (in up to 30 steps), left edge fixed so the line doesn't jump.
    const steps = Math.min(30, lines.replace(/\s/g, '').length);
    const typing = Math.min(1.6, Math.max(0.3, lines.length * 0.045));
    const longest = Math.max(...lines.split('\n').map((l) => l.length));
    const x = `(w-${Math.round(px * 0.62 * longest)})/2`;
    const out2 = [];
    for (let i = 1; i <= steps; i++) {
      const shown = lines.slice(0, Math.ceil((lines.length * i) / steps));
      const from = n3(a + (typing * (i - 1)) / steps);
      const to = i === steps ? b : n3(a + (typing * i) / steps);
      out2.push(await draw(shown, `${out ? `:alpha='1${out}'` : ''}:enable='between(t,${from},${to})'`, x));
    }
    return out2.join(',');
  };
  const addSfx = (name, at, volume = 1) => {
    if (at >= dur) return;
    const sfx = label('s');
    const mixed = label('a');
    g.push(`${SFX[name].join(',')},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${volume},adelay=${Math.round(Math.max(0, at) * 1000)}:all=1[${sfx}]`);
    g.push(`[${A}][${sfx}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[${mixed}]`);
    A = mixed;
  };
  if (transition?.sound) for (const t of transitionTimes) addSfx(transition.sound, Math.max(0, t - 0.1), 0.8);
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
        vf(`setpts=PTS/${op.x},fps=${FPS}`);
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
        vf(await drawText(op.text, op));
        if (op.sound) addSfx(op.sound, op.range ? op.range[0] : 0);
        break;
      case 'sfx':
        addSfx(op.name, op.at, op.volume);
        break;
      case 'transition':
        break;
      case 'zoom': {
        // zoompan reads frame numbers: the stream is a steady 30 fps here (speed re-times it).
        const tt = `(in/${FPS})`;
        let z;
        if (op.slow) z = `1+${n3(op.amount - 1)}*min(1,in/${Math.max(1, Math.round(dur * FPS))})`;
        else {
          const [a, b] = clampRange(op.range);
          const r = `clip(min((${tt}-${n3(a)})/0.25,(${n3(b)}-${tt})/0.25),0,1)`;
          z = `1+${n3(op.amount - 1)}*${r}*${r}*(3-2*${r})`;
        }
        vf(`zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},setsar=1`);
        break;
      }
      case 'shake': {
        const [a, b] = clampRange(op.range);
        const amp = Math.max(2, Math.round(Math.min(W, H) * 0.02 * op.strength));
        const [base, moved, shaken, o] = [label('x'), label('x'), label('x'), label('v')];
        g.push(`[${V}]split[${base}][${moved}]`);
        g.push(`[${moved}]crop=${W - 2 * amp}:${H - 2 * amp}:'${amp}+${amp}*sin(t*53)':'${amp}+${amp}*cos(t*47)',scale=${W}:${H},setsar=1[${shaken}]`);
        g.push(`[${base}][${shaken}]overlay=0:0:enable='between(t,${n3(a)},${n3(b)})'[${o}]`);
        V = o;
        break;
      }
      case 'flash':
        vf(`eq=brightness='0.75*max(0,1-abs(t-${n3(op.at)})/0.18)':eval=frame`);
        break;
      case 'progress': {
        const h = Math.max(6, Math.round(H * 0.008));
        vf(`drawbox=x=0:y=${op.at === 'top' ? 0 : H - h}:w='iw*min(1,t/${n3(Math.max(0.1, dur))})':h=${h}:color=${op.color}@0.9:t=fill`);
        break;
      }
      case 'captions':
        if (!io.transcribe) throw new Error('Auto captions need the Buddo desktop app or `buddo web` (speech recognition runs there). Use text steps with timestamps instead.');
        captions = op;
        break;
      case 'fade': {
        const d = Math.min(op.d, dur / 2);
        if (op.dir !== 'out') (vf(`fade=t=in:st=0:d=${d}`), af(`afade=t=in:st=0:d=${d}`));
        if (op.dir !== 'in') (vf(`fade=t=out:st=${(dur - d).toFixed(3)}:d=${d}`), af(`afade=t=out:st=${(dur - d).toFixed(3)}:d=${d}`));
        break;
      }
      case 'music': {
        const k = addInput('-stream_loop', '-1', '-i', await io.input(op.file));
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
        const html = HTML_EXT.test(op.file);
        const still = !html && IMAGE_EXT.test(op.file) && !/\.gif$/i.test(op.file);
        let k;
        if (html) {
          // Animated UI overlay: render the page with a see-through background at the video's size.
          if (!io.htmlOverlay) throw new Error(`HTML overlays (${op.file}) need the Buddo desktop app or \`buddo web\` with Chrome. Use a PNG overlay or text steps here.`);
          const r = await io.htmlOverlay(op.file, { W, H, fps: FPS, seconds: op.range ? b - a : undefined });
          k = addInput('-framerate', String(FPS), '-i', r.pattern);
          notes.push(`Rendered ${op.file} as a ${r.seconds.toFixed(1)}s transparent overlay.`, ...(r.notes || []));
        } else k = addInput('-i', await io.input(op.file));
        const o = label('x');
        const chain = ['format=rgba'];
        if (op.scale) chain.push(`scale=${Math.round(W * op.scale)}:-2`);
        else if (!html) chain.push(`scale='min(${W},iw)':'min(${H},ih)':force_original_aspect_ratio=decrease`);
        if (op.opacity < 1) chain.push(`colorchannelmixer=aa=${op.opacity}`);
        if (!still) chain.push(`setpts=PTS-STARTPTS+${a.toFixed(3)}/TB`);
        g.push(`[${k}:v]${chain.join(',')}[${o}]`);
        const [x, y] = POS[op.pos] || POS.center;
        const m = Math.round(Math.min(W, H) * 0.04);
        const o2 = label('v');
        // A single picture must stay up after its one frame; clips disappear when they end.
        g.push(`[${V}][${o}]overlay=x=${x.replace(/m/g, m)}:y=${y.replace(/m/g, m)}:eof_action=${still ? 'repeat' : 'pass'}:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})',format=yuv420p[${o2}]`);
        V = o2;
        break;
      }
    }
  }

  // 3. Render.
  const result = await io.output(target);
  const gif = ext(target) === '.gif';
  const graph = io.temp('graph.txt');
  await io.writeText(graph, g.join(';\n'));
  const mainOut = captions ? io.temp('main.mp4') : result;
  const enc = ['-filter_complex_script', graph, '-map', `[${V}]`, '-map', `[${A}]`, ...io.encode(captions ? 'main.mp4' : target, { audio: !gif }), '-t', Math.max(0.1, dur).toFixed(3)];
  if (captions) await io.ffmpeg([...args, ...enc, '-y', mainOut]);
  else await io.finish([...args, ...enc], result);

  // 4. Captions: listen to the edited video, then burn the words in.
  if (captions) {
    const segs = await io.transcribe(mainOut);
    const chunks = captionChunks(segs, H > W ? 4 : 7);
    notes.push(chunks.length ? `Captions: ${chunks.length} lines from ${segs.length} speech segments.` : '⚠ Captions: no speech found, so no captions were added.');
    if (chunks.length) {
      const filters = [];
      for (const c of chunks) filters.push(await drawText(c.text, { at: captions.at, range: [c.start, c.end], size: Math.round(Math.min(W, H) / 13) }));
      const script = io.temp('captions.txt');
      await io.writeText(script, `[0:v]${filters.join(',\n')}[v]`);
      await io.finish(['-v', 'error', '-i', mainOut, '-filter_complex_script', script, '-map', '[v]', '-map', '0:a?', ...io.encode(target, { audio: !gif })], result);
    } else {
      await io.finish(['-v', 'error', '-i', mainOut, '-c', 'copy'], result);
    }
  }
  return { out: target, path: result, notes: [`Edited ${list.join(' + ')} → ${ops.length ? ops.map((o) => o.type).join(', ') : 'joined'}.`, ...notes], ops };
}
