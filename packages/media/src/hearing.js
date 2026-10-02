// Hearing: speech-to-text with timestamps (Silero VAD + Whisper), sound recognition (AudioSet) and loudness.

import path from 'node:path';
import { createRequire } from 'node:module';
import { ffmpeg } from './ffmpeg.js';
import { ensureModel, modelPath } from './models.js';

const require = createRequire(import.meta.url);
const SR = 16000;
let sherpa;
const sherpaLib = () => (sherpa ||= require('sherpa-onnx-node'));
const threads = () => Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency || 4) - 1));

let recognizer;
let tagger;

async function getRecognizer(onProgress) {
  if (recognizer) return recognizer;
  const dir = await ensureModel('whisper', onProgress);
  recognizer = new (sherpaLib().OfflineRecognizer)({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: path.join(dir, 'tiny-encoder.int8.onnx'), decoder: path.join(dir, 'tiny-decoder.int8.onnx'), language: '', task: 'transcribe' },
      tokens: path.join(dir, 'tiny-tokens.txt'),
      numThreads: threads(),
      provider: 'cpu',
      debug: 0,
    },
  });
  return recognizer;
}

async function getTagger(onProgress) {
  if (tagger) return tagger;
  const dir = await ensureModel('sounds', onProgress);
  tagger = new (sherpaLib().AudioTagging)({
    model: { zipformer: { model: path.join(dir, 'model.int8.onnx') }, numThreads: threads(), debug: 0 },
    labels: path.join(dir, 'class_labels_indices.csv'),
  });
  return tagger;
}

/** Decode any audio/video file to 16 kHz mono float samples. */
export async function decodeAudio(file, { start = 0, end } = {}) {
  const args = [];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', file);
  if (end) args.push('-t', String(Math.max(0.1, end - start)));
  args.push('-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1');
  const { stdout } = await ffmpeg(['-v', 'error', ...args], { timeout: 600000 });
  const copy = new Uint8Array(stdout.length - (stdout.length % 4));
  copy.set(stdout.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}

async function speechSegments(samples, onProgress) {
  const model = await ensureModel('vad', onProgress);
  const vad = new (sherpaLib().Vad)(
    {
      sileroVad: { model, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.4, windowSize: 512, maxSpeechDuration: 20 },
      sampleRate: SR,
      debug: false,
      numThreads: 1,
    },
    Math.ceil(samples.length / SR) + 30,
  );
  const segs = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const s = vad.front(false);
      segs.push({ start: s.start / SR, samples: Float32Array.from(s.samples) });
      vad.pop();
    }
  };
  for (let i = 0; i + 512 <= samples.length; i += 512) {
    vad.acceptWaveform(samples.subarray(i, i + 512));
    drain();
  }
  vad.flush();
  drain();
  return segs;
}

const NOISE_TEXT = /^[\s.,!?♪*()[\]-]*$|^\(?(music|applause|laughs?|silence|inaudible)\)?\.?$/i;

export async function transcribe(samples, offset = 0, onProgress) {
  const rec = await getRecognizer(onProgress);
  const segs = await speechSegments(samples, onProgress);
  const out = [];
  let lang = '';
  for (const s of segs) {
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: SR, samples: s.samples });
    rec.decode(stream);
    const r = rec.getResult(stream);
    const text = (r.text || '').trim();
    if (!text || NOISE_TEXT.test(text)) continue;
    lang ||= r.lang;
    out.push({ start: offset + s.start, end: offset + s.start + s.samples.length / SR, text });
  }
  return { language: lang.replace(/[<>|]/g, ''), segments: out };
}

const IGNORE_SOUNDS = new Set(['Silence', 'Inside, small room', 'Inside, large room or hall', 'Outside, urban or manmade', 'Outside, rural or natural']);

/** Recognize sounds over time. Returns overall top sounds and a merged timeline. */
export async function recognizeSounds(samples, offset = 0, onProgress) {
  const tg = await getTagger(onProgress);
  const dur = samples.length / SR;
  const tag = (chunk, k) => {
    const st = tg.createStream();
    st.acceptWaveform({ sampleRate: SR, samples: chunk });
    return tg.compute(st, k).filter((x) => !IGNORE_SOUNDS.has(x.name));
  };
  const overall = tag(samples.length > SR * 30 ? samples.subarray(0, SR * 30) : samples, 8).filter((x) => x.prob > 0.15);

  // Windowed timeline (window grows for long audio to stay fast).
  const win = Math.max(2, Math.ceil(dur / 60));
  const timeline = [];
  for (let t = 0; t < dur - 0.3; t += win) {
    const chunk = samples.subarray(Math.floor(t * SR), Math.floor(Math.min(dur, t + win) * SR));
    for (const x of tag(chunk, 3)) {
      if (x.prob < 0.3) continue;
      const last = timeline.findLast((e) => e.label === x.name);
      if (last && Math.abs(last.end - (offset + t)) < 0.01) {
        last.end = offset + Math.min(dur, t + win);
        last.prob = Math.max(last.prob, x.prob);
      } else timeline.push({ label: x.name, start: offset + t, end: offset + Math.min(dur, t + win), prob: x.prob });
    }
  }
  timeline.sort((a, b) => a.start - b.start || b.prob - a.prob);
  return { overall: overall.map((x) => ({ label: x.name, prob: x.prob })), timeline };
}

/** Loudness envelope (dB per 0.5 s), loudest moments and silent stretches. */
export function loudness(samples, offset = 0) {
  const step = SR / 2;
  const env = [];
  for (let i = 0; i < samples.length; i += step) {
    let sum = 0;
    const end = Math.min(samples.length, i + step);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    env.push(10 * Math.log10(sum / Math.max(1, end - i) + 1e-10));
  }
  const avg = env.length ? env.reduce((a, b) => a + b, 0) / env.length : -90;
  const peaks = env
    .map((db, i) => ({ t: offset + i * 0.5, db }))
    .filter((p) => p.db > avg + 6)
    .sort((a, b) => b.db - a.db)
    .slice(0, 3)
    .sort((a, b) => a.t - b.t);
  const silences = [];
  let s0 = -1;
  env.forEach((db, i) => {
    if (db < -45) {
      if (s0 < 0) s0 = i;
    } else {
      if (s0 >= 0 && i - s0 >= 2) silences.push({ start: offset + s0 * 0.5, end: offset + i * 0.5 });
      s0 = -1;
    }
  });
  if (s0 >= 0 && env.length - s0 >= 2) silences.push({ start: offset + s0 * 0.5, end: offset + env.length * 0.5 });
  return { avgDb: Math.round(avg), peaks: peaks.map((p) => ({ t: p.t, db: Math.round(p.db) })), silences, envelope: env.map((x) => Math.round(x)) };
}

/** Full hearing pass on a decoded clip. */
export async function hear(samples, { offset = 0, speech = true, sounds = true, onProgress } = {}) {
  const [stt, snd] = await Promise.all([
    speech ? transcribe(samples, offset, onProgress) : null,
    sounds ? recognizeSounds(samples, offset, onProgress) : null,
  ]);
  return { speech: stt, sounds: snd, loudness: loudness(samples, offset), duration: samples.length / SR };
}

export const preloadHearing = (onProgress) => Promise.all([getRecognizer(onProgress), getTagger(onProgress), ensureModel('vad', onProgress)]);
export { modelPath };
