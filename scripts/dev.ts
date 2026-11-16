/**
 * Development: runs the game server (restarting on changes) and the Vite dev server together.
 * Open the URL Vite prints (http://localhost:5173); it proxies /api and /ws to the game server.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const run = (cmd: string, args: string[]) => spawn(cmd, args, { cwd: root, stdio: 'inherit', env: process.env });

const children = [
  run(process.execPath, ['--watch', 'src/server/main.ts']),
  run(process.execPath, [join(root, 'node_modules/vite/bin/vite.js')]),
];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
};
for (const c of children) c.on('exit', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
