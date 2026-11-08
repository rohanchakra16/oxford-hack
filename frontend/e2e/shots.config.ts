import { defineConfig, devices } from '@playwright/test';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export const SHOTS_URL = 'http://127.0.0.1:25844';
export const SHOTS_BACKEND = 'http://127.0.0.1:28844';
/** Headset-free rehearsal: the real main page + real backend/adapter on the scripted TEST EEG source. */
export default defineConfig({
  testDir: './shots', workers: 1, retries: 0,
  outputDir: '../test-results/shots',
  reporter: [['list'], ['html', { outputFolder: '../playwright-report/shots', open: 'never' }]],
  use: { baseURL: SHOTS_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: `"${process.env.EVALUATION_PYTHON ?? 'python'}" -m oxford_hack.cli serve --port 28844 --allowed-origin ${SHOTS_URL} --frontend-url ${SHOTS_URL} --launch-token-file frontend/test-results/shots-token --no-simulated --live-eeg-reminders --eeg-source integration.rehearsal.scripted_eeg:make_source --log-level warning`,
      cwd: root, env: { PYTHONPATH: [root, `${root}/platform/src`].join(delimiter), OXFORD_REHEARSAL_EEG: '1' },
      url: `${SHOTS_BACKEND}/api/v0/health`, reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 25844 --strictPort',
      cwd: fileURLToPath(new URL('../', import.meta.url)), env: { VITE_BACKEND_URL: SHOTS_BACKEND },
      url: SHOTS_URL, reuseExistingServer: false },
  ],
});
