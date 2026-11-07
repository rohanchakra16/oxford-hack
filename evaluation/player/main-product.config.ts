import { defineConfig } from '../../frontend/node_modules/@playwright/test/index.mjs';
import original from './playwright.config';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  ...original,
  testMatch: 'main-product.spec.ts',
  outputDir: '../../frontend/test-results/main-focus',
  reporter: [['list']],
  use: { ...original.use, baseURL: 'http://127.0.0.1:5175' },
  webServer: [
    { command: `"${process.env.EVALUATION_PYTHON ?? 'python'}" -m evaluation.player_api --port 18769`, cwd: root,
      env: { PYTHONPATH: `${root}${process.platform === 'win32' ? ';' : ':'}${root}/platform/src` }, url: 'http://127.0.0.1:18769/health', reuseExistingServer: false },
    { command: 'node frontend/node_modules/vite/bin/vite.js frontend --config frontend/vite.config.ts', cwd: root,
      env: { EVALUATION_API_URL: 'http://127.0.0.1:18769', EVALUATION_PLAYER_PORT: '5175' },
      url: 'http://127.0.0.1:5175', reuseExistingServer: false },
  ],
});
