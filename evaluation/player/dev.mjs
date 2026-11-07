import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const candidates = ['platform', 'inference'].map((area) => join(root, area, '.venv', windows ? 'Scripts/python.exe' : 'bin/python'));
const python = process.env.EVALUATION_PYTHON ?? candidates.find(existsSync) ?? 'python';
const env = { ...process.env, PYTHONPATH: [root, join(root, 'platform/src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) };
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 500);
}
function run(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
const apiPort = new URL(process.env.EVALUATION_API_URL ?? 'http://127.0.0.1:18766').port;
run(python, ['-m', 'evaluation.player_api', '--port', apiPort, ...process.argv.slice(2)]);
run(process.execPath, [join(root, 'frontend/node_modules/vite/bin/vite.js'), '--config', join(root, 'evaluation/player/vite.config.mjs')]);
console.log(`\nLecture evaluation: http://127.0.0.1:${process.env.EVALUATION_PLAYER_PORT ?? 15174} — open a local video of at least 40 seconds.\n`);
