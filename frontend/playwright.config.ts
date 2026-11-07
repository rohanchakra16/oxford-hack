import { defineConfig, devices } from '@playwright/test';

/**
 * Infrastructure e2e tests (Person 5): the real Vite frontend talking to the real FastAPI backend over a
 * real WebSocket, on dedicated loopback ports so they never collide with `npm run dev`.
 * The backend runs with --enable-test-hooks (tests only) and a throwaway launch token.
 */
export const FRONTEND_PORT = 15173;
export const BACKEND_PORT = 18765;
export const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
export const TOKEN_FILE = 'test-results/e2e-launch-token';

export default defineConfig({
  testDir: './e2e/infra',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1, // one backend with in-memory sessions is shared by every test
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: FRONTEND_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: [
        'uv run oxford-backend serve',
        `--port ${BACKEND_PORT}`,
        `--allowed-origin ${FRONTEND_URL}`,
        `--frontend-url ${FRONTEND_URL}`,
        `--launch-token-file ../frontend/${TOKEN_FILE}`,
        '--enable-test-hooks --log-level warning',
      ].join(' '),
      cwd: '../platform',
      url: `${BACKEND_URL}/api/v0/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${FRONTEND_PORT} --strictPort`,
      env: { VITE_BACKEND_URL: BACKEND_URL },
      url: FRONTEND_URL,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
