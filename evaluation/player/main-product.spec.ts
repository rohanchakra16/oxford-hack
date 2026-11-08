import { test, expect } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { makeSyntheticLecture } from '../../frontend/e2e/infra/makeVideo';

test('main frontend calibrates, saves combined flags, keeps manual markers and replays at the end', async ({ page }) => {
  test.setTimeout(75_000);
  const lecture = await makeSyntheticLecture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Deterministic webcam contract fixture; the product, gaze buffer, Python fusion,
  // cooldown, review cards and actual player run unchanged.
  await page.route('**/gaze-runtime*', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    export function createGazeCamera(options) {
      let timer;
      return {
        start: async () => {},
        calibrate: async () => {
          options.onCalibration({id:'product-fixture',status:'valid'});
          timer=setInterval(() => {const now=performance.now();options.onObservation({
            observationId:'fixture-'+now,tBrowserFrameMs:now,tBrowserProcessedMs:now,
            measurementKind:'screen_gaze',calibrationId:'product-fixture',valid:true,
            invalidReasons:[],insideVideo:options.getVideoElement().currentTime<14,
            videoPoint:{x:0.5,y:0.5},modelConfidence:0.9
          });},65);
        },
        getCalibration:()=>null,
        stop:()=>clearInterval(timer)
      };
    }
  ` }));
  await page.goto('/?adapter=synthetic');
  await expect(page.getByRole('heading', { name: /Find your way back/ })).toBeVisible();
  await page.locator('input[type="file"][accept*="video"]').setInputFiles(lecture);
  await page.getByRole('button', { name: 'Session setup', exact: true }).click();
  await page.getByRole('button', { name: 'Calibrate EEG + gaze' }).click();
  await page.getByRole('button', { name: 'Continue to lecture', exact: true }).click();
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect(page.getByRole('status', { name: 'Focus heads-up' })).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('article.bookmark-card')).toHaveCount(1);
  const flags = page.getByRole('navigation', { name: 'Saved bookmark flags' });
  await expect(flags.getByRole('button')).toHaveCount(1);
  const timestamp = Number(/PT([\d.]+)S/.exec((await page.locator('article.bookmark-card time').getAttribute('datetime'))!)![1]);
  await page.getByRole('button', { name: /Mark this moment at/ }).click();
  await expect(page.locator('article.bookmark-card')).toHaveCount(2);
  await page.locator('video').evaluate(async (v: HTMLVideoElement) => { v.currentTime = v.duration - 0.2; await v.play(); });
  await expect(page.getByRole('heading', { name: /End-of-lecture bookmarks/ })).toBeVisible();
  await flags.getByRole('button').first().click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(timestamp + 2);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), { timeout: 15000 }).toBe(true);
  await expect(page.locator('article.bookmark-card')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/main-focus/main-frontend.png', fullPage: true });
  expect(errors).toEqual([]);
});
