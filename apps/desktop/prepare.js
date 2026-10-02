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
copy(web, path.join(app, 'web'));
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ type: 'module', private: true }));
console.log('✓ desktop app prepared');
