import { defineConfig } from '../../frontend/node_modules/@playwright/test/index.mjs';
import original from '../../frontend/playwright.config';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  ...original,
  testDir: '../../frontend/e2e/infra',
  outputDir: '../../frontend/test-results/infra',
  reporter: [['list'], ['html', { outputFolder: '../../frontend/playwright-report/infra', open: 'never' }]],
  webServer: [
    { command: `"${process.env.EVALUATION_PYTHON ?? 'python'}" -m oxford_hack.cli serve --port 18765 --allowed-origin http://127.0.0.1:15173 --frontend-url http://127.0.0.1:15173 --launch-token-file frontend/test-results/e2e-launch-token --enable-test-hooks --log-level warning`,
      cwd: root, env: { PYTHONPATH: [root, `${root}/platform/src`].join(delimiter) },
      url: 'http://127.0.0.1:18765/api/v0/health', reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 15173 --strictPort',
      cwd: fileURLToPath(new URL('../../frontend/', import.meta.url)),
      env: { VITE_BACKEND_URL: 'http://127.0.0.1:18765' },
      url: 'http://127.0.0.1:15173', reuseExistingServer: false },
  ],
});
