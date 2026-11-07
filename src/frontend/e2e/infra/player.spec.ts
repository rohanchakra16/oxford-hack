/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { FRONTEND_URL } from '../../playwright.config';
import { LECTURE_SECONDS, makeSyntheticLecture } from './makeVideo';
import { backendState, launchToken } from './helpers';

/**
 * Real <video> playback through Person 4's LecturePlayer, forwarding telemetry via attachMediaElement to the
 * real backend. The lecture is a synthetic WebM generated at test time (never committed).
 */
const HARNESS = `${FRONTEND_URL}/src/player/dev/index.html`;

let lecture: string;
test.beforeAll(async () => {
  lecture = await makeSyntheticLecture();
});

async function openPlayer(page: Page) {
  await page.goto(`${HARNESS}#pair=${launchToken()}`);
  await expect(page.getByRole('status').first()).toContainText('connection: connected', { timeout: 15_000 });
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect(page.locator('video.lp-video')).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeCloseTo(LECTURE_SECONDS, -1);
  await expect(page.getByRole('status').first()).toContainText('session: ses-', { timeout: 15_000 });
}

const t = (page: Page) => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime);

test('real video plays, pauses and seeks, and the backend sees the telemetry segments', async ({ page }) => {
  await openPlayer(page);
  await page.getByRole('button', { name: /^play$/i }).click();
  await expect.poll(() => t(page), { timeout: 10_000 }).toBeGreaterThan(1.5);
  await page.getByRole('button', { name: /^pause$/i }).click();
  const paused = await t(page);
  await page.waitForTimeout(800);
  expect(await t(page)).toBeCloseTo(paused, 1);

  await page.getByRole('button', { name: 'seek(30)' }).click();
  await expect.poll(() => t(page)).toBeCloseTo(30, 0);

  await expect.poll(async () => (await backendState()).sessions.some((s) => s.segments.length >= 1), { timeout: 10_000 }).toBe(true);
});

test('replayRange plays the requested range and stops at its end', async ({ page }) => {
  await openPlayer(page);
  await page.getByLabel('start').fill('5');
  await page.getByLabel('end').fill('8');
  await page.getByRole('button', { name: 'replayRange' }).click();
  await expect.poll(() => t(page), { timeout: 5_000 }).toBeGreaterThanOrEqual(5);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), { timeout: 10_000 }).toBe(true);
  const end = await t(page);
  expect(end).toBeGreaterThanOrEqual(8);
  expect(end).toBeLessThan(8.6); // overshoot is bounded by one timeupdate interval (~0.25 s) at 1x
});

test('a non-video file is rejected with a readable error', async ({ page }) => {
  await openPlayer(page);
  await page.locator('input[type="file"][accept*="video"]').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await expect(page.getByRole('alert')).toContainText(/does not look like a video/i);
});

test('a suggestion shown during real playback replays the lecture from before the suggested point', async ({ page }) => {
  test.setTimeout(90_000);
  // The player harness only starts "live" sessions (no sensors here, so no automatic suggestions); the
  // explicitly SYNTHETIC adapter supplies the suggestion. Backend-mapped bookmarks are covered in pipeline.spec.ts.
  await page.goto(`${HARNESS}?adapter=synthetic`);
  await expect(page.getByRole('status').first()).toContainText('SYNTHETIC DATA');
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeCloseTo(LECTURE_SECONDS, -1);
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 6; }); // a user scrub
  await expect.poll(() => t(page)).toBeCloseTo(6, 0);
  await page.getByRole('button', { name: /^play$/i }).click();
  const item = page.getByRole('listitem').filter({ hasText: 'suggested at' });
  await expect(item).toHaveCount(1, { timeout: 45_000 });
  const before = await t(page);
  await item.getByRole('button', { name: 'Replay' }).click();
  await expect.poll(() => t(page), { timeout: 5_000 }).toBeLessThan(before - 1);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), { timeout: 5_000 }).toBe(false);
});
