import { defineConfig } from '@playwright/test';
import base from './main-eeg.config';

export default defineConfig({ ...base, testMatch: ['**/setup.spec.ts', '**/calibration-geometry.spec.ts', '**/gaze-feedback.spec.ts'],
  outputDir: '../test-results/setup', reporter: [['list']] });
