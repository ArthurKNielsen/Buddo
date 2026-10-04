// Video edits Buddo plans itself for small models: "make it a TikTok with a hook title, text on the best part and
// sound effects". Tiny models can't write edit steps (or refuse), but the request maps onto a clean edit: a hook
// title that pops in, a punch zoom + boom + text on the loudest moment, transitions between clips, a fade out.

const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;

const EDIT_WORDS = /\b(edit|tik ?toks?|shorts?|reels?|stor(?:y|ies)|vertical|title|hook|text|caption|subtitle|sound|sfx|effects?|whoosh|boom|music|song|beat|trim|cut|shorten|vertical|zoom|transition|intro|outro|animat\w*|make (?:it|this|a|me)|turn (?:it|this)|clean|fire|viral|better|again|redo|remix|speed|slow ?mo|faster)\b/i;
const ASKS_ABOUT = /^(?:what|describe|summar|tell me|explain|who|where|why|how (?:long|many))\b/i;

/** Files the user attached to this chat (newest first), from the notes Buddo adds when saving them. */
export function attachedMedia(messages = []) {
  const videos = [];
  const audios = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    const found = [...m.content.matchAll(/\[Attached (video|audio): saved to the project as (\S+?)(?=[\]\s])/g)];
    // The newest message's attachments win; older ones are a fallback ("edit it again").
    const v = found.filter((x) => x[1] === 'video' || VIDEO.test(x[2])).map((x) => x[2]);
    const a = found.filter((x) => x[1] === 'audio' || AUDIO.test(x[2])).map((x) => x[2]);
    if (v.length && !videos.length) videos.push(...v);
    if (a.length && !audios.length) audios.push(...a);
    if (videos.length && audios.length) break;
  }
  return { videos, audios };
}

/** The user's words without the notes Buddo appended (attachments, files). */
export const requestText = (content = '') => content.split(/\n\n(?:\[Attached |<file path=|\()/)[0].replace(/(^|\s)@[\w./-]+/g, ' ').trim();

/** Is this a request to edit the attached video (not a question about it)? */
export function wantsVideoEdit(request, { attachedNow = false } = {}) {
  const r = request.trim();
  if (!r) return attachedNow;
  if (ASKS_ABOUT.test(r) && !EDIT_WORDS.test(r.replace(ASKS_ABOUT, ''))) return false;
  return EDIT_WORDS.test(r) || (attachedNow && r.split(/\s+/).length <= 3);
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const t2 = (x) => Number(x.toFixed(2));
const hm = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/**
 * Turn the request into edit_video steps.
 * info: { videos, audios, duration (s, of all videos), loudest (s or null), canCaption }
 * Returns { input, steps, out, did: [plain-words list], notes: [what couldn't be done] }.
 */
export function planQuickVideo(request = '', { videos = [], audios = [], duration = 0, loudest = null, canCaption = false } = {}) {
  const r = request.toLowerCase();
  const quotes = [...request.matchAll(/"([^"]+)"|“([^”]+)”/g)].map((m) => (m[1] ?? m[2]).trim()).filter(Boolean);
  const steps = [];
  const did = [];
  const notes = [];
  const has = (re) => re.test(r);
  const plain = has(/\b(no|without|skip) (effects?|sounds?|text|titles?)\b|\bjust (trim|cut|crop)\b|\bplain\b/);
  const pro = !plain; // "make it a TikTok" / "edit this" → the full clean package unless asked to keep it plain

  if (videos.length > 1) {
    steps.push('transition slide 0.4 whoosh');
    did.push('slide transitions with a whoosh between the clips');
  }
  let dur = Math.max(0.5, duration - (videos.length > 1 ? 0.4 * (videos.length - 1) : 0));

  // Length: "first 15 seconds", "make it 30 sec", "under a minute".
  const secs = /(?:first|only|keep|under|max(?:imum)?|to|make it|cut it to|shorten (?:it )?to)\s+(\d+(?:\.\d+)?)\s*(s\b|secs?|seconds?|m\b|mins?|minutes?)/.exec(r);
  if (secs) {
    const n = Number(secs[1]) * (/^m/.test(secs[2]) ? 60 : 1);
    if (n > 0 && n < dur) {
      steps.push(`trim 0-${t2(n)}`);
      did.push(`kept the first ${n < 60 ? `${n} seconds` : hm(n)}`);
      dur = n;
    }
  }
  if (has(/\b(speed (?:it )?up|faster|2x)\b/)) {
    steps.push(has(/2x/) ? 'speed 2' : 'speed 1.5');
    dur /= has(/2x/) ? 2 : 1.5;
    did.push('sped it up');
  } else if (has(/\bslow[ -]?mo(?:tion)?\b/)) {
    steps.push('speed 0.5');
    dur *= 2;
    did.push('slow motion');
  }

  // Shape: TikTok / Shorts / Reels are vertical; the whole frame stays (blurred sides), unless they say crop/fill.
  if (has(/\b(tik ?toks?|shorts?|reels?|stor(?:y|ies)|vertical|portrait|9[:x]16)\b/)) {
    steps.push(has(/\b(crop|fill|zoom in)\b/) ? 'crop vertical' : 'fit vertical');
    did.push('made it vertical (9:16)');
  } else if (has(/\bsquare\b/)) {
    steps.push('fit square');
    did.push('made it square');
  }

  const look = /\b(black and white|b&w|bw|grayscale|vintage|cinematic|warm|cool|vivid|vibrant)\b/.exec(r)?.[1];
  if (look) {
    steps.push(`color ${look === 'b&w' || look === 'black and white' || look === 'grayscale' ? 'bw' : look === 'vibrant' ? 'vivid' : look}`);
    did.push(`${look} colors`);
  }

  const sounds = pro && !has(/\b(no|without) (sound )?effects?\b|\bno sounds?\b/);
  const wantsTitle = has(/\b(hook|title|intro|heading)\b/) || (pro && !has(/\b(no|without) (title|text)\b/));
  const wantsBest = has(/\b(best part|highlight|key moment|climax|funniest|craziest)\b/) || (pro && !has(/\b(no|without) text\b/));
  const titleEnd = Math.min(2.2, dur * 0.35);
  if (wantsTitle && dur >= 1.5) {
    const title = quotes[0] || (loudest !== null && loudest > 3 ? 'Wait for it…' : 'Watch this');
    steps.push(`title "${title.replace(/"/g, '')}" 0-${t2(titleEnd)}${sounds ? ' sound pop' : ''}`);
    did.push(`a hook title "${title}" that pops in${sounds ? ' with a pop sound' : ''}`);
  }

  // The best part: the loudest moment (crowd, laugh, bang), else a bit past the middle.
  if (wantsBest && dur >= 4) {
    const guess = loudest !== null && loudest < dur ? loudest : dur * 0.55;
    const best = clamp(guess, titleEnd + 0.4, dur - 1.6);
    const textEnd = Math.min(best + 2.6, dur - 0.3);
    const words = quotes[wantsTitle ? 1 : 0] || 'No way!';
    steps.push(`zoom 1.25 ${t2(Math.max(0, best - 0.15))}-${t2(Math.min(dur - 0.2, best + 1))}`);
    if (sounds) steps.push(`sound boom ${t2(best)} volume 0.7`);
    steps.push(`text "${words.replace(/"/g, '')}" top ${t2(best)}-${t2(textEnd)} slide${sounds ? ' sound whoosh' : ''}`);
    did.push(`on the best part (${hm(best)}${loudest !== null ? ', the loudest moment' : ''}): a punch zoom${sounds ? ' + boom' : ''} and "${words}" sliding in${sounds ? ' with a whoosh' : ''}`);
  } else if (quotes.length && !wantsTitle) {
    steps.push(`text "${quotes[0].replace(/"/g, '')}" top slide`);
    did.push(`the text "${quotes[0]}"`);
  }

  if (has(/\b(captions?|subtitles?)\b/)) {
    if (canCaption) {
      steps.push('captions');
      did.push('captions from the speech');
    } else notes.push("Auto captions need the Buddo desktop app (the website can't hear speech yet).");
  }
  if (has(/\b(music|song|beat|soundtrack)\b/)) {
    if (audios.length) {
      steps.push(`music ${audios[0]} volume 0.25`);
      did.push(`${audios[0]} as quiet background music`);
    } else notes.push('For music, attach a song (🎬 button → pick an audio file) and ask again.');
  }
  if (has(/\bprogress\b/)) {
    steps.push('progress color yellow');
    did.push('a progress bar');
  }
  if (pro && dur >= 3) {
    steps.push('fade out 0.5');
    did.push('a smooth fade out');
  }
  if (!steps.length) return null;
  const base = (videos[0].split('/').pop().replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-') || 'video').slice(0, 30);
  const kind = has(/\btik ?tok/) ? 'tiktok' : has(/\bshorts?\b/) ? 'short' : has(/\breels?\b/) ? 'reel' : 'edit';
  return { input: videos.join('\n'), steps: steps.join('\n'), out: `videos/${base}-${kind}.mp4`, did, notes };
}
