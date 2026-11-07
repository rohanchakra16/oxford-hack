/// <reference lib="dom" />
import { expect, test } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { makeSyntheticLecture } from '../../frontend/e2e/infra/makeVideo';

let lecture: string;
test.beforeAll(async () => { lecture = await makeSyntheticLecture(); });

test('real player ignores the brief dip, shows one heads-up, saves media time, and replays without duplicates', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect(page.getByTestId('evaluation-status')).toHaveText('unknown', { timeout: 15_000 });
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(8);
  await expect(page.getByTestId('bookmark-count')).toHaveText('0');
  await expect(page.getByTestId('heads-up')).toBeVisible({ timeout: 35_000 });
  await expect(page.getByTestId('bookmark-count')).toHaveText('1');
  const moment = page.getByTestId('review-moment');
  const start = Number(/PT([\d.]+)S/.exec((await moment.locator('time').getAttribute('datetime'))!)![1]);
  expect(start).toBeGreaterThanOrEqual(14);
  expect(start).toBeLessThan(20);
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await page.screenshot({ path: 'test-results/evaluation/player-heads-up.png', fullPage: true });
  await page.getByRole('button', { name: 'Close heads-up' }).click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(30);
  await expect(page.getByTestId('heads-up')).toHaveCount(0);
  await moment.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(start + 2);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), { timeout: 20_000 }).toBe(true);
  await expect(page.getByTestId('bookmark-count')).toHaveText('1');
  await expect(page.getByTestId('heads-up')).toHaveCount(0);
  await moment.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(moment.getByText('Dismissed')).toBeVisible();
  await page.screenshot({ path: 'test-results/evaluation/player-smoke.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('evaluation failure is visible and leaves video playback available', async ({ page }) => {
  await page.route('**/evaluation-api/**', (route) => route.abort());
  await page.goto('/');
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect(page.getByTestId('evaluation-status')).toHaveText('Unavailable');
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1);
  await expect(page.getByTestId('bookmark-count')).toHaveText('0');
});
