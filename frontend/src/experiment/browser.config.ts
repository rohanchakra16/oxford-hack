import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.', testMatch: 'browser.spec.ts', workers: 1, retries: 0,
  outputDir: '../../../test-results/experiment', reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:25869', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 25869 --strictPort',
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    url: 'http://127.0.0.1:25869', reuseExistingServer: false,
  },
});
