// Free local models for Buddo's senses. All hosted on GitHub releases and cached in ~/.buddo/models.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SHERPA = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export const MODELS = {
  whisper: {
    label: 'Speech recognition (Whisper tiny, 99 languages)',
    url: `${SHERPA}/asr-models/sherpa-onnx-whisper-tiny.tar.bz2`,
    dir: 'sherpa-onnx-whisper-tiny',
    check: 'tiny-encoder.int8.onnx',
    keep: /int8|tokens/,
    size: 110,
  },
  sounds: {
    label: 'Sound recognition (AudioSet, 527 sounds)',
    url: `${SHERPA}/audio-tagging-models/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15.tar.bz2`,
    dir: 'sherpa-onnx-zipformer-small-audio-tagging-2024-04-15',
    check: 'model.int8.onnx',
    keep: /int8|labels/,
    size: 90,
  },
  vad: {
    label: 'Voice activity detection (Silero)',
    url: `${SHERPA}/asr-models/silero_vad.onnx`,
    file: 'silero_vad.onnx',
    size: 1,
  },
  vision: {
    label: 'Object detection (YOLO11n, 80 objects)',
    url: 'https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.onnx',
    file: 'yolo11n.onnx',
    size: 11,
  },
};

export function modelsDir() {
  return process.env.BUDDO_MODELS || path.join(os.homedir(), '.buddo', 'models');
}

export function modelPath(id) {
  const m = MODELS[id];
  return path.join(modelsDir(), m.file || m.dir);
}

export function isInstalled(id) {
  const m = MODELS[id];
  return fs.existsSync(m.file ? modelPath(id) : path.join(modelPath(id), m.check));
}

export function status() {
  return Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, sizeMB: m.size, installed: isInstalled(id) }));
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const counter = new TransformStream({
    transform(chunk, ctrl) {
      done += chunk.length;
      onProgress?.({ done, total });
      ctrl.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), fs.createWriteStream(dest));
}

function untar(file, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['xjf', file], { cwd, stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
  });
}

const pending = new Map();

/** Download a model if it is missing. Safe to call concurrently. */
export function ensureModel(id, onProgress) {
  if (isInstalled(id)) return Promise.resolve(modelPath(id));
  if (pending.has(id)) return pending.get(id);
  const job = (async () => {
    const m = MODELS[id];
    const dir = modelsDir();
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${id}-${process.pid}.part`);
    const report = (p) => onProgress?.({ id, label: m.label, ...p });
    report({ done: 0, total: 0, stage: 'download' });
    try {
      await download(m.url, tmp, report);
      if (m.file) {
        await fsp.rename(tmp, modelPath(id));
      } else {
        report({ stage: 'extract' });
        await untar(tmp, dir);
        await fsp.rm(tmp, { force: true });
        // Keep only what we use (quantized weights + labels) to save disk space.
        for (const f of await fsp.readdir(modelPath(id))) {
          if (!m.keep.test(f)) await fsp.rm(path.join(modelPath(id), f), { recursive: true, force: true });
        }
      }
      report({ stage: 'done' });
      return modelPath(id);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      pending.delete(id);
    }
  })();
  pending.set(id, job);
  return job;
}

export async function ensureAll(onProgress) {
  for (const id of Object.keys(MODELS)) await ensureModel(id, onProgress);
}
