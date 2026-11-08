import { defineConfig } from '../../frontend/node_modules/@playwright/test/index.mjs';
import base from '../../frontend/e2e/main-eeg.config';
export default defineConfig({ ...base, testDir: '../../', testMatch: ['**/evaluation/player/live-product.spec.ts', '**/frontend/e2e/live/main-eeg.spec.ts', '**/frontend/e2e/live/remind.spec.ts'],
  outputDir: '../../frontend/test-results/live-combined', reporter: [['list']] });
