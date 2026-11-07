import { defineConfig, devices } from '@playwright/test';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export const MAIN_URL = 'http://127.0.0.1:25842';
export const MAIN_BACKEND = 'http://127.0.0.1:28842';
export default defineConfig({
  testDir: './live', workers: 1, retries: 0,
  outputDir: '../test-results/main-eeg',
  reporter: [['list'], ['html', { outputFolder: '../playwright-report/main-eeg', open: 'never' }]],
  use: { baseURL: MAIN_URL, trace: 'on', screenshot: 'on' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: `"${process.env.EVALUATION_PYTHON ?? 'python'}" -m oxford_hack.cli serve --port 28842 --allowed-origin ${MAIN_URL} --frontend-url ${MAIN_URL} --launch-token-file frontend/test-results/main-eeg-token --enable-test-hooks --live-eeg-reminders --eeg-source inference.tests.live_source_fixture:make_source --log-level warning`,
      cwd: root, env: { PYTHONPATH: [root, `${root}/platform/src`].join(delimiter), OXFORD_TEST_EEG_SOURCE: '1' },
      url: `${MAIN_BACKEND}/api/v0/health`, reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 25842 --strictPort',
      cwd: fileURLToPath(new URL('../', import.meta.url)), env: { VITE_BACKEND_URL: MAIN_BACKEND },
      url: MAIN_URL, reuseExistingServer: false },
  ],
});
