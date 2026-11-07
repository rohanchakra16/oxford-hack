/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { REHEARSAL_URL } from '../rehearsal.config';
import { makeSyntheticLecture } from '../infra/makeVideo';

test('rehearsal: labelled Test EEG, a brief crossing does not remind, a sustained episode bookmarks', async ({ page }) => {
  test.setTimeout(120_000);
  const lecture = await makeSyntheticLecture();
  const token = readFileSync('frontend/test-results/rehearsal-token', 'utf8').trim();
  await page.goto(`${REHEARSAL_URL}/?signals=eeg#pair=${token}`);
  await expect(page.getByText('Session connected')).toBeVisible();
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  const banner = page.getByTestId('test-eeg-banner');
  await expect(banner).toContainText('Test EEG + real webcam');
  await expect(banner).toContainText('No headset');
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.loop = true; return v.play(); });
  const startedAt = Date.now();
  const reminders = page.getByTestId('review-reminder');
  // The script crosses the threshold briefly at 30 s (no reminder) and stays low from 45 s (reminder ~59 s).
  await page.waitForTimeout(44_000);
  await expect(reminders).toHaveCount(0);
  await expect(reminders).toHaveCount(1, { timeout: 40_000 });
  expect((Date.now() - startedAt) / 1000).toBeGreaterThan(50);
  await expect(page.locator('article.bookmark-card')).toHaveCount(1);
  await expect(banner).toBeVisible();
});
