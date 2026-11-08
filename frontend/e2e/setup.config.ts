import { defineConfig } from '@playwright/test';
import base from './main-eeg.config';

export default defineConfig({ ...base, testMatch: '**/setup.spec.ts',
  outputDir: '../test-results/setup', reporter: [['list']] });
