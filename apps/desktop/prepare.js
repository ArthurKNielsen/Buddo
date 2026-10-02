// Copies the shared core, the local server and the built web UI into ./app
// so the desktop app is self-contained when packaged.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const app = path.join(here, 'app');
const web = path.join(repo, 'apps/web/dist');

if (!fs.existsSync(path.join(web, 'index.html'))) {
  console.log('Building web UI…');
  execSync('npm run build', { cwd: repo, stdio: 'inherit' });
}
fs.rmSync(app, { recursive: true, force: true });
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes(`${path.sep}test${path.sep}`) });
copy(path.join(repo, 'packages/core'), path.join(app, 'node_modules/@buddo/core'));
copy(path.join(repo, 'packages/server'), path.join(app, 'node_modules/@buddo/server'));
copy(path.join(repo, 'packages/media'), path.join(app, 'node_modules/@buddo/media'));

// Senses: native runtimes + ffmpeg (copied as-is; N-API modules work in Electron).
const plat = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const osName = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[process.platform];
const skip = (src) =>
  // onnxruntime-node ships every OS; keep ours. onnxruntime-web: keep only the Node fallback build.
  (/onnxruntime-node[\\/]bin[\\/]napi-v\d+[\\/]/.test(src) && !new RegExp(`napi-v\\d+[\\\\/]${osName}`).test(src) && /napi-v\d+[\\/][a-z0-9]+/.test(src)) ||
  (/onnxruntime-web[\\/]dist[\\/]/.test(src) && !/ort\.node\.min\.mjs$|ort-wasm-simd-threaded\.(mjs|wasm)$/.test(src)) ||
  /\.map$/.test(src);
for (const mod of ['sherpa-onnx-node', `sherpa-onnx-${plat}`, 'onnxruntime-node', 'onnxruntime-common', 'onnxruntime-web', 'ffmpeg-static', 'playwright-core']) {
  const from = path.join(repo, 'node_modules', mod);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(app, 'node_modules', mod), { recursive: true, dereference: true, filter: (src) => !skip(src) });
  else console.warn(`  (skipping ${mod}: not installed)`);
}
copy(web, path.join(app, 'web'));
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ type: 'module', private: true }));
console.log('✓ desktop app prepared');
