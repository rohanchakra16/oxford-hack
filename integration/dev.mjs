#!/usr/bin/env node
/**
 * `npm run dev` from the repo root: starts the local backend (loopback only) and the Vite frontend together,
 * prints the pairing link, and stops both on Ctrl-C. Owner: Person 5. Extra args go to `oxford-backend serve`,
 * e.g. `npm run dev -- --simulated-detector baseline`. `npm run dev -- --rehearsal` runs scripted TEST EEG (no headset).
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = 'http://127.0.0.1:5173';
const children = [];

function run(name, cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const tag = (stream, out) =>
    stream.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => out.write(`[${name}] ${l}\n`)));
  tag(child.stdout, process.stdout);
  tag(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`[${name}] exited (${code}); stopping.`);
      stop(code ?? 1);
    }
  });
  children.push(child);
}

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

// `--rehearsal`: headset-free rehearsal. Scripted TEST EEG scores + the browser's real webcam; the page says
// "Test EEG + real webcam". Never a headset. Without the flag nothing scripted is ever loaded.
const rehearsal = process.argv.includes('--rehearsal');
const passthrough = process.argv.slice(2).filter((a) => a !== '--rehearsal');
const rehearsalArgs = rehearsal
  ? ['--no-simulated', '--live-eeg-reminders', '--eeg-source', 'integration.rehearsal.scripted_eeg:make_source']
  : [];
run('backend', 'uv', ['run', 'oxford-backend', 'serve', '--frontend-url', FRONTEND, ...rehearsalArgs, ...passthrough], join(root, 'platform'),
  rehearsal ? { OXFORD_REHEARSAL_EEG: '1' } : {});
run('frontend', 'npx', ['vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], join(root, 'frontend'));
console.log(`\nDev stack starting. Open the pairing link printed by [backend] (it ends in #pair=...).\nDiagnostics: ${FRONTEND}/diagnostics\n`);
