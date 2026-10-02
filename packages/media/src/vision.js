// Vision: fast object detection (YOLO11n via onnxruntime-web/WASM — no native install needed).

import fs from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import { ensureModel } from './models.js';

const require = createRequire(import.meta.url);
export const SIZE = 640;

export const COCO = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'];

let sessionP;
let ort;

async function session(onProgress) {
  if (!sessionP) {
    sessionP = (async () => {
      const file = await ensureModel('vision', onProgress);
      const threads = Math.max(1, Math.min(4, os.cpus().length));
      // Native onnxruntime is ~6× faster; fall back to the WASM build if it isn't installed.
      try {
        ort = require('onnxruntime-node');
        return await ort.InferenceSession.create(file, { intraOpNumThreads: threads, graphOptimizationLevel: 'all' });
      } catch {
        ort = await import(require.resolve('onnxruntime-web').replace(/ort\.[^/\\]*$/, 'ort.node.min.mjs'));
        ort.env.wasm.numThreads = threads;
        return ort.InferenceSession.create(await fs.readFile(file), { graphOptimizationLevel: 'all' });
      }
    })().catch((e) => {
      sessionP = null;
      throw e;
    });
  }
  return sessionP;
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter);
}

/**
 * Detect objects in a letterboxed 640×640 RGB24 buffer.
 * `frame` = { width, height } of the original image (to map boxes back).
 */
export async function detect(rgb, frame, { threshold = 0.35, onProgress } = {}) {
  const s = await session(onProgress);
  const n = SIZE * SIZE;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i] = rgb[i * 3] / 255;
    data[i + n] = rgb[i * 3 + 1] / 255;
    data[i + 2 * n] = rgb[i * 3 + 2] / 255;
  }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]) });
  const o = out[s.outputNames[0]];
  const [, C, N] = o.dims;
  const d = o.data;
  const scale = Math.min(SIZE / frame.width, SIZE / frame.height);
  const padX = (SIZE - frame.width * scale) / 2;
  const padY = (SIZE - frame.height * scale) / 2;
  let boxes = [];
  for (let i = 0; i < N; i++) {
    let best = 0;
    let cls = -1;
    for (let c = 4; c < C; c++) {
      const v = d[c * N + i];
      if (v > best) {
        best = v;
        cls = c - 4;
      }
    }
    if (best < threshold) continue;
    const cx = d[i];
    const cy = d[N + i];
    const w = d[2 * N + i];
    const h = d[3 * N + i];
    boxes.push({
      cls,
      score: best,
      x1: (cx - w / 2 - padX) / scale,
      y1: (cy - h / 2 - padY) / scale,
      x2: (cx + w / 2 - padX) / scale,
      y2: (cy + h / 2 - padY) / scale,
    });
  }
  boxes.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of boxes) if (!keep.some((k) => k.cls === b.cls && iou(k, b) > 0.45)) keep.push(b);
  return keep.map((b) => ({
    label: COCO[b.cls],
    score: Math.round(b.score * 100) / 100,
    box: [b.x1, b.y1, b.x2, b.y2].map((v) => Math.round(v)),
    where: position(b, frame),
  }));
}

function position(b, f) {
  const cx = (b.x1 + b.x2) / 2 / f.width;
  const cy = (b.y1 + b.y2) / 2 / f.height;
  const v = cy < 0.33 ? 'top' : cy > 0.66 ? 'bottom' : 'middle';
  const h = cx < 0.33 ? 'left' : cx > 0.66 ? 'right' : 'center';
  const area = ((b.x2 - b.x1) * (b.y2 - b.y1)) / (f.width * f.height);
  return `${v === 'middle' && h === 'center' ? 'center' : `${v}-${h}`}${area > 0.3 ? ', large' : area < 0.02 ? ', small' : ''}`;
}

/** "teddy bear ×9, person (center, large)" */
export function summarizeObjects(objs) {
  if (!objs.length) return 'no common objects detected';
  const groups = new Map();
  for (const o of objs) groups.set(o.label, [...(groups.get(o.label) || []), o]);
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || b[1][0].score - a[1][0].score)
    .map(([label, list]) => (list.length > 1 ? `${label} ×${list.length}` : `${label} (${list[0].where})`))
    .join(', ');
}

export const preloadVision = (onProgress) => session(onProgress);
