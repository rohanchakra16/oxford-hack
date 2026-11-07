/** Main product frontend + physical Unicorn backend. Never selects a test source. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  'frontend-port': { type: 'string', default: '5173' },
  'backend-port': { type: 'string', default: '8765' },
} });
for (const port of [values['frontend-port'], values['backend-port']]) {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid loopback port');
}
const frontend = `http://127.0.0.1:${values['frontend-port']}`;
const backend = `http://127.0.0.1:${values['backend-port']}`;
const candidates = ['inference', 'platform'].map((area) => join(root, area, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
const python = process.env.EEG_PYTHON ?? process.env.EVALUATION_PYTHON ?? candidates.find(existsSync) ?? 'python';
const env = { ...process.env, PYTHONPATH: [root, join(root, 'platform/src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) };
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill();
  }
  setTimeout(() => process.exit(code), 500);
}
function run(command, args, extra = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extra }, windowsHide: true, stdio: 'inherit' });
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
run(python, ['-m', 'oxford_hack.cli', 'serve', '--port', values['backend-port'],
  '--frontend-url', frontend, '--allowed-origin', frontend, '--no-simulated', '--live-eeg-reminders']);
run(process.execPath, [join(root, 'frontend/node_modules/vite/bin/vite.js'), join(root, 'frontend'), '--config', join(root, 'frontend/vite.config.ts'),
  '--host', '127.0.0.1', '--port', values['frontend-port'], '--strictPort'], { VITE_BACKEND_URL: backend });
console.log(`\nMAIN APP + PHYSICAL UNICORN: ${frontend}. Open the backend's pairing link.\nNo SDK/headset -> EEG unavailable; never scripted data.\n`);
