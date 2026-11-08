import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { makeSyntheticLecture } from './makeVideo';

let lecture: string;
test.beforeAll(async () => { lecture = await makeSyntheticLecture(); });

async function loadLecture(page: Page, query = '') {
  await page.goto(`/${query}`);
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.duration)).toBeGreaterThan(30);
  await page.getByRole('tab', { name: /^Moments/ }).click();
}

async function seekPaused(page: Page, time: number) {
  await page.locator('video').evaluate((video: HTMLVideoElement, at) => { video.pause(); video.currentTime = at; }, time);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.seeking)).toBe(false);
}

test('self-bookmarks work without a backend, retain the exact time, and appear in graph statistics', async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort());
  await loadLecture(page);
  await seekPaused(page, 12.5);
  await page.getByRole('button', { name: 'Bookmark this moment', exact: true }).click();
  await expect(page.getByTestId('bookmark-saved')).toContainText('Bookmark saved at 0:12');
  const card = page.locator('.bookmark-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('time')).toHaveAttribute('datetime', 'PT12.5S');
  await expect(card.getByText('Your marker', { exact: true })).toBeVisible();
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await page.getByRole('tab', { name: /^Attention/ }).click();
  await expect(page.locator('.att-marker--bookmark')).toHaveCount(1);
  await page.getByRole('button', { name: 'Attention summary', exact: true }).click();
  await expect(page.locator('#panel-attention .att-graph')).toHaveCount(1);
  const stat = page.getByTestId('attention-summary').locator('.att-stat').filter({ has: page.locator('dt', { hasText: /^Bookmarks$/ }) });
  await expect(stat.locator('.att-stat__value')).toHaveText('1');
});

test('toolbar bookmarks survive reopening the lecture, replay, dismiss, and stay separate from another video', async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort());
  await loadLecture(page);
  await seekPaused(page, 7);
  await page.getByRole('button', { name: /^Mark this moment at/ }).click();
  await expect(page.locator('.bookmark-card')).toHaveCount(1);
  await page.reload();
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect(page.locator('.bookmark-card')).toHaveCount(1);
  const card = page.locator('.bookmark-card');
  await expect(card.locator('time')).toHaveAttribute('datetime', 'PT7S');
  await seekPaused(page, 22);
  await card.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeLessThan(10);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await card.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(card.getByText('Dismissed for this view')).toBeVisible();
  await page.locator('input[type="file"][accept*="video"]').setInputFiles({ name: 'another-lecture.webm', mimeType: 'video/webm', buffer: readFileSync(lecture) });
  await expect(page.locator('.bookmark-card')).toHaveCount(0);
  await expect(page.getByTestId('bookmark-saved')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bookmark this moment', exact: true })).toBeEnabled();
});

test('self-bookmarks remain available when experimental mode is enabled and disabled', async ({ page }) => {
  await loadLecture(page, '?adapter=synthetic');
  await seekPaused(page, 5);
  await page.getByRole('button', { name: 'Bookmark this moment', exact: true }).click();
  await page.getByRole('button', { name: /Session setup/ }).click();
  await page.getByText('Experimental mode · testing only', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Enable experimental mode', exact: true }).check();
  await page.getByRole('button', { name: 'Continue to lecture', exact: true }).click();
  await expect(page.locator('.bookmark-card')).toHaveCount(1);
  await seekPaused(page, 10);
  await page.getByRole('button', { name: 'Bookmark this moment', exact: true }).click();
  await expect(page.locator('.bookmark-card')).toHaveCount(2);
  await page.getByRole('tab', { name: /^Attention/ }).click();
  await expect(page.locator('.att-marker--bookmark')).toHaveCount(2);
  await page.getByRole('button', { name: /Session setup/ }).click();
  await page.getByRole('checkbox', { name: 'Enable experimental mode', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Continue to lecture', exact: true }).click();
  await page.getByRole('tab', { name: /^Moments/ }).click();
  await expect(page.locator('.bookmark-card')).toHaveCount(2);
});
