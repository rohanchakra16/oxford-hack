import { defineConfig, devices } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: 'player.spec.ts', workers: 1, retries: 0,
  outputDir: '../../frontend/test-results/evaluation',
  reporter: [['list'], ['html', { outputFolder: '../../frontend/playwright-report/evaluation', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:15174', trace: 'on', screenshot: 'on' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: process.env.EVALUATION_PYTHON ? `"${process.env.EVALUATION_PYTHON}" -m evaluation.player_api` : 'python -m evaluation.player_api',
      cwd: root, env: { PYTHONPATH: [root, `${root}/platform/src`].join(delimiter) },
      url: 'http://127.0.0.1:18766/health', reuseExistingServer: !process.env.CI },
    { command: 'node frontend/node_modules/vite/bin/vite.js --config evaluation/player/vite.config.mjs',
      cwd: root, url: 'http://127.0.0.1:15174', reuseExistingServer: !process.env.CI },
  ],
});
