import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: './infra', testMatch: 'self-bookmarks.spec.ts', workers: 1,
  outputDir: '../test-results/self-bookmarks', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:15194', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 15194 --strictPort',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: 'http://127.0.0.1:15194', reuseExistingServer: false,
  },
});
