/// <reference lib="dom" />
import { expect, test } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { makeSyntheticLecture } from '../../frontend/e2e/infra/makeVideo';

let lecture: string;
test.beforeAll(async () => { lecture = await makeSyntheticLecture(); });

test('real player ignores the brief dip, shows one heads-up, saves media time, and replays without duplicates', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?signals=eeg');
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
  await page.locator('video').evaluate(async (v: HTMLVideoElement) => { v.currentTime = v.duration - 0.2; await v.play(); });
  await expect(page.getByTestId('end-review')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'End-of-lecture bookmarks' })).toBeVisible();
  const flag = page.getByRole('navigation', { name: 'Saved bookmark flags' }).getByRole('button');
  await flag.click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(start + 2);
  await expect(page.getByTestId('bookmark-count')).toHaveText('1');
  await expect(page.getByTestId('end-review')).toBeVisible();
  await page.screenshot({ path: 'test-results/evaluation/player-smoke.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('evaluation failure is visible and leaves video playback available', async ({ page }) => {
  await page.route('**/evaluation-api/**', (route) => route.abort());
  await page.goto('/?signals=eeg');
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect(page.getByTestId('evaluation-status')).toHaveText('Unavailable');
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1);
  await expect(page.getByTestId('bookmark-count')).toHaveText('0');
});

test('combined EEG and gaze calibrate before a sustained threshold crossing saves a flag', async ({ page }) => {
  test.setTimeout(70_000);
  // Synthetic, calibrated gaze windows exercise the real Python fusion and real player.
  // This fixture is not a camera/accuracy measurement.
  await page.route('**/evaluation-api/sessions/*/tick', async (route) => {
    const body = route.request().postDataJSON();
    await route.continue({ postData: JSON.stringify({ ...body, gaze: {
      calibrationId: 'synthetic-calibration', calibrationValid: true,
      validFraction: 1, outsideFraction: body.mediaS >= 14 ? 1 : 0,
      windowMs: 1000, newestAgeMs: 20, maxGapMs: 70,
    } }) });
  });
  await page.goto('/');
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect(page.getByRole('button', { name: 'Calibrate EEG + gaze' })).toBeEnabled();
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect(page.getByTestId('fusion-status')).toContainText(/Baseline ready|Combining baseline-adjusted/, { timeout: 15_000 });
  await expect(page.getByTestId('bookmark-count')).toHaveText('0');
  await expect(page.getByTestId('heads-up')).toBeVisible({ timeout: 35_000 });
  await expect(page.getByTestId('bookmark-count')).toHaveText('1');
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await expect(page.getByRole('navigation', { name: 'Saved bookmark flags' }).getByRole('button')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/evaluation/combined-focus-bookmark.png', fullPage: true });
  // A lost camera must suppress further detection while retaining the saved bookmark.
  await page.unroute('**/evaluation-api/sessions/*/tick');
  await expect(page.getByTestId('evaluation-status')).toHaveText('unknown', { timeout: 6000 });
  await expect(page.getByTestId('bookmark-count')).toHaveText('1');
  await page.route('**/evaluation-api/**', (route) => route.abort());
  await expect(page.getByTestId('evaluation-status')).toHaveText('Unavailable', { timeout: 6000 });
  await expect(page.getByRole('navigation', { name: 'Saved bookmark flags' }).getByRole('button')).toHaveCount(1);
  await page.getByRole('navigation', { name: 'Saved bookmark flags' }).getByRole('button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(25);
});

test('uncalibrated gaze stays unknown and never asks for camera permission on load', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: () => { throw new Error('Unexpected camera request'); } });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(2);
  await expect(page.getByTestId('evaluation-status')).toHaveText('unknown');
  await expect(page.getByTestId('bookmark-count')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('calibration can be cancelled without pausing the player or keeping the camera active', async ({ page }) => {
  // Exercise our calibration UI/lifecycle through the public camera adapter.
  await page.route('**/gaze-runtime*', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    export function createGazeCamera(options) {
      return {
        start: async () => {},
        calibrate: (ui, signal) => new Promise((resolve, reject) => {
          options.onCalibration({id: 'fixture-calibration', status: 'in_progress'});
          ui.show({x: 180, y: 180}, 0, 1);
          signal.addEventListener('abort', () => {ui.hide(); reject(new DOMException('Cancelled', 'AbortError'));}, {once: true});
        }),
        stop: () => {document.documentElement.dataset.cameraStopped = 'true';}
      };
    }
  ` }));
  await page.goto('/');
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.getByRole('button', { name: 'Calibrate EEG + gaze' }).click();
  await expect(page.getByRole('dialog', { name: 'Gaze calibration' })).toBeVisible();
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Gaze calibration' })).toHaveCount(0);
  await expect(page.getByTestId('gaze-status')).toContainText('Camera stopped');
  await expect(page.locator('html')).toHaveAttribute('data-camera-stopped', 'true');
  await expect(page.getByTestId('bookmark-count')).toHaveText('0');
});
