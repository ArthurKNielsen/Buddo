// Dev mode: Buddo server (API + model proxy) on :4141 and Vite (hot reload) on :5173.
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['packages/cli/bin/buddo.js', 'web', '--no-open', ...process.argv.slice(2)], { stdio: 'inherit' }),
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev', '-w', 'apps/web'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
