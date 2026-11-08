/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { FRONTEND_URL } from '../../playwright.config';
import { LECTURE_SECONDS, makeSyntheticLecture } from './makeVideo';

/**
 * #55 attention UI as mounted in the main app (product/App.tsx): sidebar graph, ⓘ indicator in the player
 * overlay slot, view modes on one mounted player, and the end-of-lecture summary. Synthetic adapter (labelled)
 * supplies suggestions; live mode must show markers only plus "Live score unavailable".
 */
let lecture: string;
test.beforeAll(async () => {
  lecture = await makeSyntheticLecture();
});

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/attention-${name}.png`, fullPage: true });

async function openLecture(page: Page, url: string) {
  await page.goto(url);
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeCloseTo(LECTURE_SECONDS, -1);
}

test('graph, ⓘ indicator, view modes and summary are mounted on the main page', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openLecture(page, `${FRONTEND_URL}/?adapter=synthetic`);

  const graph = page.getByTestId('attention-graph-compact');
  await expect(page.locator('.side-column').getByTestId('attention-graph-compact')).toBeVisible();
  await expect(page.getByTestId('player-overlay-slot')).toBeAttached();

  // A synthetic suggestion becomes a graph marker and raises the ⓘ on the video, without pausing playback.
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 6; void v.play(); });
  await expect(page.locator('article.bookmark-card').first()).toBeVisible({ timeout: 45_000 });
  const info = page.getByTestId('player-overlay-slot').getByTestId('attention-info');
  await expect(info.getByRole('button', { name: /Show details/ })).toBeVisible({ timeout: 10_000 });
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await expect(graph.getByRole('button', { name: /review point/i }).first()).toBeVisible();
  await shot(page, 'normal');

  // Minimise: same <video> element (not remounted), moved beside the sidebar, still playing.
  await page.locator('video').evaluate((v) => { (window as unknown as { __video: Element }).__video = v; });
  await page.getByRole('button', { name: 'Minimise player' }).click();
  await expect(page.locator('.content-grid--minimised')).toBeVisible();
  expect(await page.locator('video').evaluate((v) => v === (window as unknown as { __video: Element }).__video)).toBe(true);
  const playerBox = (await page.locator('.player-card').boundingBox())!;
  const transcriptBox = (await page.locator('.transcript-card').boundingBox())!;
  expect(playerBox.x).toBeGreaterThan(transcriptBox.x + transcriptBox.width - 1);
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await shot(page, 'minimised');

  // Maximise, then Esc back to normal; the overlay stays inside the player.
  await page.getByRole('button', { name: 'Restore player size' }).click();
  await page.getByRole('button', { name: 'Maximise player' }).click();
  await expect(page.locator('.lp--maximised')).toBeVisible();
  await expect(page.locator('.lp--maximised').getByTestId('player-overlay-slot')).toBeAttached();
  await page.waitForTimeout(400); // let the 200 ms grow animation finish before the screenshot
  await page.screenshot({ path: 'test-results/attention-maximised.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.lp--maximised')).toHaveCount(0);

  // A graph marker routes through the shared replay path (seeks back to the suggestion).
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 30; });
  // Click the marker head (the stem is click-through by design so close markers stay separately clickable).
  await graph.getByRole('button', { name: /review point/i }).first().locator('.att-marker__hit').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 5_000 }).toBeLessThan(30);

  // End of lecture: the summary opens.
  await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = v.duration - 0.3; void v.play(); });
  await expect(page.getByTestId('attention-summary')).toBeVisible({ timeout: 15_000 });
  await shot(page, 'summary');
});

test('live mode: markers only, labelled "Live score unavailable"', async ({ page }) => {
  await page.goto(`${FRONTEND_URL}/`);
  await expect(page.getByTestId('attention-graph-compact').getByText('Live score unavailable')).toBeVisible();
});
