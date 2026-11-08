/** Main product frontend + physical Unicorn backend. Never selects a test source. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  'frontend-port': { type: 'string', default: '5173' },
  'backend-port': { type: 'string', default: '8765' },
  'model-factory': { type: 'string' },
  'no-open': { type: 'boolean', default: false },
} });
for (const port of [values['frontend-port'], values['backend-port']]) {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid loopback port');
}
const frontend = `http://127.0.0.1:${values['frontend-port']}`;
const backend = `http://127.0.0.1:${values['backend-port']}`;
// Installation settings are remembered once; users never enter model details in the player.
const settingsPath = join(root, '.local', 'eeg-launch.json');
let settings = {};
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) ?? {}; }
  catch { console.error('Saved EEG launch settings could not be read. Reconfigure the model once with --model-factory.'); }
}
const factory = values['model-factory'] ?? process.env.REMIND_MODEL_FACTORY ?? settings.modelFactory;
if (factory && (typeof factory !== 'string' || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$/.test(factory))) {
  throw new Error('Model factory must be a Python module:factory');
}
if (values['model-factory']) {
  mkdirSync(join(root, '.local'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ modelFactory: factory }, null, 2) + '\n', { mode: 0o600 });
}
const candidates = ['inference', 'platform'].map((area) => join(root, area, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
const python = process.env.EEG_PYTHON ?? process.env.EVALUATION_PYTHON ?? candidates.find(existsSync) ?? 'python';
const env = { ...process.env, ...(factory ? { REMIND_MODEL_FACTORY: factory } : {}),
  PYTHONPATH: [root, join(root, 'platform/src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) };
const children = [];
let stopping = false;
let pairToken = null;
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
function run(command, args, extra = {}, capturePairing = false) {
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extra }, windowsHide: true,
    stdio: ['ignore', capturePairing ? 'pipe' : 'inherit', 'inherit'] });
  if (capturePairing) {
    let output = '';
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      output = (output + data.toString()).slice(-8192);
      pairToken = output.match(/#pair=([A-Za-z0-9_-]{16,256})/)?.[1] ?? pairToken;
    });
  }
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
run(python, ['-m', 'oxford_hack.cli', 'serve', '--port', values['backend-port'],
  '--frontend-url', frontend, '--allowed-origin', frontend, '--no-simulated', '--live-eeg-reminders'], {}, true);
run(process.execPath, [join(root, 'frontend/node_modules/vite/bin/vite.js'), join(root, 'frontend'), '--config', join(root, 'frontend/vite.config.ts'),
  '--host', '127.0.0.1', '--port', values['frontend-port'], '--strictPort'], { VITE_BACKEND_URL: backend });
console.log(`\nMAIN APP + PHYSICAL UNICORN: ${frontend}. ${values['no-open'] ? 'Open the backend pairing link.' : 'Your paired browser will open when both services are ready.'}\nSession setup contains device checks and calibration.\n`);
if (!factory) console.log('EEG model is not installed/configured yet. Session setup will show it as unavailable.');

async function openWhenReady() {
  const deadline = Date.now() + 45_000;
  while (!stopping && Date.now() < deadline) {
    if (pairToken) {
      try {
        const responses = await Promise.all([
          fetch(`${backend}/api/v0/health`, { signal: AbortSignal.timeout(1500) }),
          fetch(frontend, { signal: AbortSignal.timeout(1500) }),
        ]);
        if (responses.every((response) => response.ok) && !stopping) {
          const url = `${frontend}/${factory ? '' : '?setup=1'}#pair=${pairToken}`;
          const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
          const browser = spawn(command, [url], { windowsHide: true, stdio: 'ignore', detached: true });
          browser.on('error', () => console.error('Could not open the browser. Open the backend pairing link above.'));
          browser.unref();
          return;
        }
      } catch { /* Both services must be ready before opening the paired page. */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!stopping) console.error('Automatic browser opening timed out. Open the backend pairing link above.');
}
if (!values['no-open']) void openWhenReady();
